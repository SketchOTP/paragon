export const CONTEXT_BANDS = [
  { label: "<32K", min: 0, max: 32000 },
  { label: "32K–80K", min: 32000, max: 80000 },
  { label: "80K–100K", min: 80000, max: 100000 },
  { label: "100K–120K", min: 100000, max: 120000 },
  { label: "120K–150K", min: 120000, max: 150000 },
  { label: ">150K", min: 150000, max: Infinity }
];

export const SESSION_DURATION_BANDS = [
  { label: "<30m", min: 0, max: 30 },
  { label: "30–60m", min: 30, max: 60 },
  { label: "1–2h", min: 60, max: 120 },
  { label: "2–4h", min: 120, max: 240 },
  { label: "4–8h", min: 240, max: 480 },
  { label: "8h+", min: 480, max: Infinity }
];

function bandFor(bands, value) {
  const band = bands.find((b) => value >= b.min && value < b.max);
  return band ? band.label : bands[bands.length - 1].label;
}

export function contextBandFor(tokens) {
  return bandFor(CONTEXT_BANDS, tokens ?? 0);
}

export function sessionDurationBandFor(minutes) {
  return bandFor(SESSION_DURATION_BANDS, minutes ?? 0);
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Aggregates runs + sessions into the bands/dimensions the directive
 * requires. Pure function over already-loaded records — no I/O.
 */
export function buildUsageSummary({ runs, sessions, now = Date.now() }) {
  const byProvider = {};
  const byModel = {};
  const byJob = {};
  const bySession = {};
  const byAgentRole = {};
  const byRootVsChild = { root: 0, child: 0 };
  const byContextBand = {};
  const bySuccessFailure = { success: 0, failure: 0, pending: 0 };
  const byFallback = { fallback: 0, direct: 0 };
  const byTimeout = { timeout: 0, ok: 0 };

  for (const run of runs) {
    bump(byProvider, run.provider ?? "unknown");
    bump(byModel, run.model ?? "unknown");
    bump(byJob, run.jobId ?? "unknown");
    bump(bySession, run.sessionId ?? "unknown");
    bump(byAgentRole, run.agentRole ?? "unknown");
    byRootVsChild[run.parentRunId ? "child" : "root"] += 1;
    bump(byContextBand, contextBandFor(run.requestContextEstimate?.estimatedInputTokens));
    if (run.success === true) bySuccessFailure.success += 1;
    else if (run.success === false) bySuccessFailure.failure += 1;
    else bySuccessFailure.pending += 1;
    byFallback[run.fallbackPosition > 0 ? "fallback" : "direct"] += 1;
    byTimeout[run.timeout ? "timeout" : "ok"] += 1;
  }

  const byDurationBand = {};
  for (const session of sessions) {
    const start = Date.parse(session.startTime);
    const end = session.endTime ? Date.parse(session.endTime) : now;
    const minutes = Number.isFinite(start) ? Math.round((end - start) / 60000) : 0;
    bump(byDurationBand, sessionDurationBandFor(minutes));
  }

  return {
    totals: { runs: runs.length, sessions: sessions.length },
    byProvider,
    byModel,
    byJob,
    bySession,
    byAgentRole,
    byRootVsChild,
    byContextBand,
    bySessionDurationBand: byDurationBand,
    bySuccessFailure,
    byFallback,
    byTimeout
  };
}
