const key = (c) => `${c.provider}/${c.providerModelId ?? c.model ?? ""}`;

export function evaluatePlan(plan = [], { failureProbability = (c) => 1 - Number(c.components?.confidenceAdjustedSuccessProbability ?? c.components?.probabilityOfSuccessfulCompletion ?? c.successProbability ?? 0.85), attemptCost = (c) => Number(c.components?.expectedTotalResourceCost ?? c.cost?.normalizedBurden ?? c.cost ?? 0), providerFailureProbability = () => 0 } = {}) {
  let probabilityAllPriorFail = 1;
  let expectedCost = 0;
  let expectedLatency = 0;
  const providersFailed = new Set();
  const providerWideSeen = new Set();
  for (const candidate of plan) {
    const providerFailure = clamp(providerFailureProbability(candidate));
    if (providerWideSeen.has(candidate.provider)) continue;
    const fail = clamp(failureProbability(candidate));
    const effectiveFail = Math.max(fail, providerFailure);
    const reach = probabilityAllPriorFail;
    expectedCost += reach * attemptCost(candidate);
    expectedLatency += reach * Number(candidate.components?.expectedLatencyMs ?? candidate.latencyMs ?? 0);
    probabilityAllPriorFail *= effectiveFail;
    if (providerFailure > 0) providersFailed.add(candidate.provider);
    if (providerFailure >= 1) providerWideSeen.add(candidate.provider);
  }
  return { expectedCost, expectedLatency, successProbability: 1 - probabilityAllPriorFail, failureProbability: probabilityAllPriorFail, providersWithCorrelatedFailure: [...providersFailed], plan: plan.map(key) };
}

export function optimizeFallbackPlan(candidates, options = {}) {
  const eligible = (candidates ?? []).filter((c) => !c.excluded && !c.pendingAssessment);
  const max = Math.min(Number(options.maximumAttempts ?? 4), eligible.length);
  const minimumAttempts = Math.min(Number(options.minimumAttempts ?? 1), max);
  let best = null;
  const visit = (prefix, remaining) => {
    if (prefix.length) {
      const score = evaluatePlan(prefix, options);
      const acceptable = prefix.length >= minimumAttempts && (options.successTarget == null || score.successProbability >= options.successTarget);
      if (acceptable && (!best || score.expectedCost < best.score.expectedCost || score.expectedCost === best.score.expectedCost && score.expectedLatency < best.score.expectedLatency)) best = { plan: prefix, score };
    }
    if (prefix.length >= max) return;
    for (let i = 0; i < remaining.length; i++) visit([...prefix, remaining[i]], [...remaining.slice(0, i), ...remaining.slice(i + 1)]);
  };
  visit([], eligible);
  if (best) return best;
  const fallback = [...eligible].sort((a, b) => Number(b.successProbability ?? b.components?.probabilityOfSuccessfulCompletion ?? 0) - Number(a.successProbability ?? a.components?.probabilityOfSuccessfulCompletion ?? 0)).slice(0, max);
  return { plan: fallback, score: evaluatePlan(fallback, options), route: "degraded_sufficiency" };
}

function clamp(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
