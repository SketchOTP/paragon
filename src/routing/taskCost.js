const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

export function estimateTaskCost({ inputTokens = 0, answerTokens = 0, reasoningTokens = 0, pricing = {}, credits = 0, quotaFraction = 0, latencyMs = 0, remaining = {} } = {}) {
  const usd = n(inputTokens) * n(pricing.inputPerToken ?? pricing.prompt) + n(answerTokens) * n(pricing.outputPerToken ?? pricing.completion) + n(reasoningTokens) * n(pricing.reasoningPerToken ?? pricing.reasoning ?? pricing.completion);
  const raw = { usd, credits: n(credits), quotaFraction: n(quotaFraction), localGpuSeconds: n(remaining.localGpuSeconds), latencyMs: n(latencyMs), inputTokens: n(inputTokens), answerTokens: n(answerTokens), reasoningTokens: n(reasoningTokens) };
  const burden = (raw.usd / Math.max(n(remaining.usd, 1), 1)) + (raw.credits / Math.max(n(remaining.credits, 1), 1)) + (raw.quotaFraction / Math.max(n(remaining.allowance, 1), 1)) + (raw.localGpuSeconds / Math.max(n(remaining.gpuBudgetSeconds, 1), 1));
  return { ...raw, normalizedBurden: burden, costPerSuccessfulTask: burden };
}

export function costPerSuccessfulTask(cost, confidenceAdjustedProbability) {
  return { ...cost, costPerSuccessfulTask: cost.normalizedBurden / Math.max(0.000001, n(confidenceAdjustedProbability)) };
}
