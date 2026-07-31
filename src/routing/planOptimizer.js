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
  const compareCandidates = (a, b) => {
    const bySuccess = Number(b.successProbability ?? b.components?.confidenceAdjustedSuccessProbability ?? b.components?.probabilityOfSuccessfulCompletion ?? 0) - Number(a.successProbability ?? a.components?.confidenceAdjustedSuccessProbability ?? a.components?.probabilityOfSuccessfulCompletion ?? 0);
    if (bySuccess) return bySuccess;
    const byCost = Number(a.components?.expectedCostPerSuccessfulTask ?? a.components?.expectedTotalResourceCost ?? a.cost ?? 0) - Number(b.components?.expectedCostPerSuccessfulTask ?? b.components?.expectedTotalResourceCost ?? b.cost ?? 0);
    if (byCost) return byCost;
    return key(a).localeCompare(key(b));
  };
  const filtered = (candidates ?? []).filter((c) => !c.excluded && !c.pendingAssessment);
  const eligible = options.pinFirst && filtered.length
    ? [filtered[0], ...filtered.slice(1).sort(compareCandidates)]
    : filtered.sort(compareCandidates);
  const max = Math.min(Number(options.maximumAttempts ?? 4), eligible.length);
  const minimumAttempts = Math.min(Number(options.minimumAttempts ?? 1), max);
  const searchBudget = Math.max(1, Number(options.searchBudget ?? 5000));
  const firstCandidate = options.pinFirst ? eligible[0] : null;
  const searchCandidates = firstCandidate ? eligible.slice(1) : eligible;
  let visited = 0;
  let best = null;
  const visit = (prefix, remaining) => {
    if (visited >= searchBudget) return;
    if (prefix.length) {
      visited += 1;
      const score = evaluatePlan(prefix, options);
      const acceptable = prefix.length >= minimumAttempts && (options.successTarget == null || score.successProbability >= options.successTarget);
      if (acceptable && (!best || score.expectedCost < best.score.expectedCost || score.expectedCost === best.score.expectedCost && score.expectedLatency < best.score.expectedLatency)) best = { plan: prefix, score };
    }
    if (prefix.length >= max) return;
    for (let i = 0; i < remaining.length && visited < searchBudget; i++) visit([...prefix, remaining[i]], [...remaining.slice(0, i), ...remaining.slice(i + 1)]);
  };
  visit(firstCandidate ? [firstCandidate] : [], searchCandidates);
  if (best) return { ...best, searchBudget, visited };
  const fallback = (options.pinFirst ? eligible : [...eligible].sort(compareCandidates)).slice(0, max);
  return { plan: fallback, score: evaluatePlan(fallback, options), route: "degraded_sufficiency", searchBudget, visited };
}

function clamp(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
