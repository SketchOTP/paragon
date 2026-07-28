export const DEFAULT_ORCHESTRATION_CONFIG = {
  enabled: true,
  mode: "live",
  retentionDays: 30,
  context: {
    warningTokens: 80000,
    checkpointTokens: 100000,
    rolloverTokens: 120000,
    absoluteCeilingTokens: 150000
  },
  session: {
    checkpointMinutes: 60,
    rolloverMinutes: 120,
    longSessionMinutes: 480,
    // Hard cutoff for explicit (caller-supplied) sessions only — implicit
    // one-request sessions are never subject to this (PARAGON-D-003R).
    hardLimitMinutes: 720
  },
  subagents: {
    parallelLimit: 2,
    totalPerJobLimit: 4,
    runtimeWarningMinutes: 45,
    recursiveChildrenAllowed: false
  },
  loops: {
    repeatedFailureWarning: 2,
    noProgressWarning: 3,
    repeatedCommandWarning: 3
  },
  concurrency: {
    maxConcurrent: 4
  },
  fallback: {
    maxAttempts: 4
  },
  circuitBreaker: {
    failureThreshold: 3,
    cooldownMs: 60000
  }
};

// "shadow" is accepted only as a migration source value (see
// migrateOrchestrationMode in configMigrate.js) — it is never valid on a
// policy that reaches validatePolicy directly.
const VALID_MODES = new Set(["off", "live"]);

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Fails safe: returns { ok:false, errors } instead of throwing, so a bad
 * PUT never corrupts the running policy. Only "off"/"live" are accepted —
 * "shadow" is a legacy value only ever produced by migration, never a
 * valid target for a direct policy write (PARAGON-D-003R).
 */
export function validatePolicy(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, errors: ["policy must be an object"] };
  }

  if (!VALID_MODES.has(candidate.mode)) {
    errors.push(`mode must be one of ${[...VALID_MODES].join(", ")}`);
  }

  const numericFields = [
    ["context.warningTokens", candidate.context?.warningTokens],
    ["context.checkpointTokens", candidate.context?.checkpointTokens],
    ["context.rolloverTokens", candidate.context?.rolloverTokens],
    ["context.absoluteCeilingTokens", candidate.context?.absoluteCeilingTokens],
    ["session.checkpointMinutes", candidate.session?.checkpointMinutes],
    ["session.rolloverMinutes", candidate.session?.rolloverMinutes],
    ["session.longSessionMinutes", candidate.session?.longSessionMinutes],
    ["session.hardLimitMinutes", candidate.session?.hardLimitMinutes],
    ["subagents.parallelLimit", candidate.subagents?.parallelLimit],
    ["subagents.totalPerJobLimit", candidate.subagents?.totalPerJobLimit],
    ["subagents.runtimeWarningMinutes", candidate.subagents?.runtimeWarningMinutes],
    ["concurrency.maxConcurrent", candidate.concurrency?.maxConcurrent],
    ["fallback.maxAttempts", candidate.fallback?.maxAttempts],
    ["circuitBreaker.failureThreshold", candidate.circuitBreaker?.failureThreshold],
    ["circuitBreaker.cooldownMs", candidate.circuitBreaker?.cooldownMs]
  ];
  for (const [name, value] of numericFields) {
    if (!isPositiveNumber(value)) {
      errors.push(`${name} must be a positive number`);
    }
  }

  if (typeof candidate.subagents?.recursiveChildrenAllowed !== "boolean") {
    errors.push("subagents.recursiveChildrenAllowed must be a boolean");
  }
  if (!isPositiveNumber(candidate.retentionDays)) {
    errors.push("retentionDays must be a positive number");
  }

  return { ok: errors.length === 0, errors };
}

export function mergeOrchestrationConfig(base, incoming) {
  return {
    ...base,
    ...incoming,
    context: { ...base.context, ...incoming?.context },
    session: { ...base.session, ...incoming?.session },
    subagents: { ...base.subagents, ...incoming?.subagents },
    loops: { ...base.loops, ...incoming?.loops },
    concurrency: { ...base.concurrency, ...incoming?.concurrency },
    fallback: { ...base.fallback, ...incoming?.fallback },
    circuitBreaker: { ...base.circuitBreaker, ...incoming?.circuitBreaker }
  };
}
