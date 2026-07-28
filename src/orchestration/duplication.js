import { hashContent } from "./redaction.js";

/**
 * Conservative, deterministic duplication signal for child runs. Never
 * uses an LLM.
 *
 * What CONFIRMED_DUPLICATION actually means: two runs are both (a) child
 * runs — i.e. carry a `parentRunId`, ruling out root requests, (b) in the
 * same session, (c) hash to the same objective (see objectiveHash below —
 * this is deliberately never derived from a system prompt, since every
 * child in a session commonly shares the same system prompt and that
 * would produce false positives), (d) report the same non-null
 * `repository`, and (e) have overlapping execution windows. All five
 * conditions must hold. Any weaker match — same objective hash without
 * repository or time corroboration — is at most POSSIBLE_DUPLICATION,
 * and a pair with nothing but a shared hash is INSUFFICIENT_EVIDENCE.
 *
 * objectiveHash's caller (telemetry.js) is responsible for only ever
 * hashing task-type + the final user-authored message, never
 * `messages[0]` — the first message is very often a shared system
 * prompt, and hashing it would make every child in a session with a
 * common preamble look like a duplicate of every other child.
 */
export function objectiveHash(taskType, objective) {
  if (!taskType || !objective) {
    return null;
  }
  return hashContent(`${taskType}::${objective}`);
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
