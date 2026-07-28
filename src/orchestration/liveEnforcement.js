/**
 * Real execution enforcement for orchestration.mode === "live"
 * (PARAGON-D-003R). Unlike shadowGovernor.js (pure proposal, never
 * mutates execution), everything exported here can actually reject a
 * request or skip a provider. Process-global state — one PARAGON process,
 * one set of counters/circuits, reset only on restart or explicitly via
 * resetForTests().
 */

let activeExecutions = 0;
const circuits = new Map(); // provider -> { failures: number[], openUntil: number }

export function activeExecutionCount() {
  return activeExecutions;
}

export function beginExecution() {
  activeExecutions += 1;
}

export function endExecution() {
  activeExecutions = Math.max(0, activeExecutions - 1);
}

/** Returns a blocking decision if the concurrency ceiling is already at capacity. */
export function checkConcurrency(policy) {
  const limit = policy.concurrency.maxConcurrent;
  if (activeExecutions >= limit) {
    return {
      blocked: true,
      reasonCode: "concurrency.maxConcurrent",
      message: `${activeExecutions} concurrent executions already at the configured limit of ${limit}.`
    };
  }
  return { blocked: false };
}

/** Returns a blocking decision if the request's estimated input context exceeds the hard ceiling. */
export function checkContextCeiling(policy, estimatedInputTokens) {
  const ceiling = policy.context.absoluteCeilingTokens;
  if (estimatedInputTokens >= ceiling) {
    return {
      blocked: true,
      reasonCode: "context.absoluteCeiling",
      message: `Estimated ${estimatedInputTokens} tokens exceeds the configured absolute ceiling of ${ceiling}.`
    };
  }
  return { blocked: false };
}

/** Caps the fallback attempt chain to the configured maximum. Never reorders. */
export function applyFallbackLimit(policy, attempts) {
  const limit = policy.fallback.maxAttempts;
  return attempts.slice(0, limit);
}

function pruneOldFailures(state, cooldownMs) {
  const cutoff = Date.now() - cooldownMs;
  state.failures = state.failures.filter((ts) => ts >= cutoff);
}

/** Call after every provider attempt to update its circuit-breaker state. */
export function recordProviderResult(policy, provider, success) {
  const state = circuits.get(provider) ?? { failures: [], openUntil: 0 };
  const now = Date.now();
  if (success) {
    state.failures = [];
    state.openUntil = 0;
  } else {
    pruneOldFailures(state, policy.circuitBreaker.cooldownMs);
    state.failures.push(now);
    if (state.failures.length >= policy.circuitBreaker.failureThreshold) {
      state.openUntil = now + policy.circuitBreaker.cooldownMs;
    }
  }
  circuits.set(provider, state);
}

/** True if the provider's circuit is currently open (should be skipped). Half-opens (clears) past cooldown. */
export function isCircuitOpen(provider) {
  const state = circuits.get(provider);
  if (!state || !state.openUntil) {
    return false;
  }
  if (Date.now() < state.openUntil) {
    return true;
  }
  // Cooldown elapsed: half-open probe — clear so the next attempt gets a real try.
  state.openUntil = 0;
  state.failures = [];
  return false;
}

/** Filters providers whose circuit is open out of a fallback attempt chain. */
export function filterOpenCircuits(attempts) {
  return attempts.filter((attempt) => !isCircuitOpen(attempt.name));
}

export function circuitStateSnapshot() {
  const now = Date.now();
  const snapshot = {};
  for (const [provider, state] of circuits) {
    snapshot[provider] = state.openUntil && now < state.openUntil ? "open" : state.failures.length ? "half-open" : "closed";
  }
  return snapshot;
}

/** Test-only: clears all in-memory enforcement state between test cases. */
export function resetForTests() {
  activeExecutions = 0;
  circuits.clear();
}
