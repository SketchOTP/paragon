import { hashContent } from "./redaction.js";

/**
 * Conservative, deterministic duplication signal for child runs. Never
 * uses an LLM. A run only counts as CONFIRMED_DUPLICATION when session,
 * repository, task type, and objective hash all agree and the runs
 * overlapped in time — anything less is POSSIBLE_DUPLICATION or
 * INSUFFICIENT_EVIDENCE.
 */
export function objectiveHash(taskType, objective) {
  if (!taskType && !objective) {
    return null;
  }
  return hashContent(`${taskType ?? ""}::${objective ?? ""}`);
}

function overlaps(a, b) {
  const aStart = Date.parse(a.startTime);
  const aEnd = a.endTime ? Date.parse(a.endTime) : Date.now();
  const bStart = Date.parse(b.startTime);
  const bEnd = b.endTime ? Date.parse(b.endTime) : Date.now();
  return aStart <= bEnd && bStart <= aEnd;
}

/** @returns {Array<{runIds:string[], classification:string, reason:string}>} */
export function detectDuplication(runs) {
  const childRuns = runs.filter((r) => r.parentRunId && r.objectiveHash);
  const results = [];
  const seen = new Set();

  for (let i = 0; i < childRuns.length; i += 1) {
    for (let j = i + 1; j < childRuns.length; j += 1) {
      const a = childRuns[i];
      const b = childRuns[j];
      if (a.sessionId !== b.sessionId || a.objectiveHash !== b.objectiveHash) {
        continue;
      }
      const pairKey = [a.id, b.id].sort().join(":");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const sameRepo = a.repository && b.repository && a.repository === b.repository;
      const timeOverlap = overlaps(a, b);

      if (sameRepo && timeOverlap) {
        results.push({
          runIds: [a.id, b.id],
          classification: "CONFIRMED_DUPLICATION",
          reason: "Same session, same repository, same normalized task/objective hash, overlapping execution window."
        });
      } else if (sameRepo || timeOverlap) {
        results.push({
          runIds: [a.id, b.id],
          classification: "POSSIBLE_DUPLICATION",
          reason: "Same session and objective hash, but repository or time-overlap evidence is only partial."
        });
      } else {
        results.push({
          runIds: [a.id, b.id],
          classification: "INSUFFICIENT_EVIDENCE",
          reason: "Same objective hash but no corroborating repository or time-overlap signal."
        });
      }
    }
  }
  return results;
}
