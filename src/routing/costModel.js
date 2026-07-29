/**
 * Reasoning-token and effective-cost model (PARAGON-D-004D, Phase 2).
 *
 * The defect this exists for: ranking used `pricing.prompt` — price per
 * million *input* tokens — as the entire cost signal. That is wrong in two
 * independent ways.
 *
 *  1. It ignores output and reasoning tokens. A model at $2.50/M running a
 *     `max` reasoning profile can consume several times the total tokens of
 *     a nominally pricier model at `low`, so the cheaper-per-million option
 *     can be the more expensive option *per completed task*.
 *  2. It ignores that Claude, Codex, Cursor and Antigravity are reached
 *     through subscriptions. Their marginal dollar cost is near zero while
 *     they consume a finite allowance, so a dollar-only model calls them
 *     free and over-selects them until the allowance is gone.
 *
 * Reasoning effort is therefore modeled as a *separate dimension* from the
 * model's token price, and quota burn as a separate currency from dollars.
 *
 * Nothing here fabricates a precise multiplier. Until measurements exist the
 * effect is expressed as a burn class plus an explicit token *range* and an
 * uncertainty penalty, and the prior is only asserted to be monotonic.
 */

import { reasoningEffortRank } from "./executionProfile.js";

export const REASONING_BURN_CLASSES = ["none", "minimal", "low", "moderate", "high", "very_high", "unknown"];

/**
 * Transparent ordinal prior mapping reasoning effort to an expected
 * reasoning-token *range*, as a multiple of visible output tokens.
 *
 * These are explicitly priors, not measurements: the ranges are wide, they
 * overlap, and any provider-returned usage or measured history overrides
 * them entirely (see estimateReasoningTokens' evidence order). The only
 * property asserted is monotonicity — a higher effort never has a lower
 * expected range than a lower effort.
 */
const REASONING_PRIOR = {
  none: { burnClass: "none", min: 0, max: 0 },
  minimal: { burnClass: "minimal", min: 0, max: 0.5 },
  low: { burnClass: "low", min: 0.25, max: 1.5 },
  medium: { burnClass: "moderate", min: 1, max: 4 },
  high: { burnClass: "high", min: 2, max: 8 },
  xhigh: { burnClass: "very_high", min: 4, max: 16 },
  max: { burnClass: "very_high", min: 6, max: 24 }
};

/** Providers reached through a subscription/allowance rather than metered API billing. */
const SUBSCRIPTION_PROVIDERS = new Set(["claude", "codex", "cursor", "antigravity"]);

/**
 * Estimates reasoning-token consumption for one candidate.
 *
 * Evidence order (directive Phase 2):
 *   1. provider-returned reasoning-token usage
 *   2. provider-returned total billed tokens
 *   3. measured provider/model/profile/task history
 *   4. provider-published profile behavior  (none published today)
 *   5. transparent ordinal prior
 *   6. unknown
 */
export function estimateReasoningTokens({
  reasoningEffort = "unknown",
  expectedVisibleOutputTokens = 0,
  telemetry = null,
  minimumSamplesForMeasuredEstimate = 10
} = {}) {
  const visible = Math.max(0, Number(expectedVisibleOutputTokens) || 0);

  // 1/2/3 — measured evidence for this exact provider/model/profile.
  const measuredReasoning = Number(telemetry?.observedReasoningTokens);
  const samples = Number(telemetry?.sampleCount ?? 0);
  if (Number.isFinite(measuredReasoning) && measuredReasoning >= 0 && samples >= minimumSamplesForMeasuredEstimate) {
    return {
      expectedReasoningTokens: Math.round(measuredReasoning),
      expectedReasoningTokenRange: { min: Math.round(measuredReasoning * 0.7), max: Math.round(measuredReasoning * 1.4) },
      reasoningBurnClass: burnClassForRatio(visible > 0 ? measuredReasoning / visible : 0),
      reasoningCostConfidence: samples >= minimumSamplesForMeasuredEstimate * 5 ? "high" : "medium",
      reasoningEstimateSource: "measured_history"
    };
  }

  // 5 — transparent ordinal prior.
  const prior = REASONING_PRIOR[reasoningEffort];
  if (!prior) {
    // 6 — unknown. Deliberately does NOT default to zero: assuming no
    // reasoning cost for an unknown profile is exactly the bias that let
    // max-effort models look cheap.
    return {
      expectedReasoningTokens: null,
      expectedReasoningTokenRange: null,
      reasoningBurnClass: "unknown",
      reasoningCostConfidence: "none",
      reasoningEstimateSource: "unknown"
    };
  }

  const min = Math.round(visible * prior.min);
  const max = Math.round(visible * prior.max);
  return {
    // Midpoint is used as the point estimate, with the range always
    // reported alongside so a caller can see how soft it is.
    expectedReasoningTokens: Math.round((min + max) / 2),
    expectedReasoningTokenRange: { min, max },
    reasoningBurnClass: prior.burnClass,
    reasoningCostConfidence: "low",
    reasoningEstimateSource: "ordinal_prior"
  };
}

function burnClassForRatio(ratio) {
  if (ratio <= 0) return "none";
  if (ratio < 0.5) return "minimal";
  if (ratio < 1.5) return "low";
  if (ratio < 4) return "moderate";
  if (ratio < 8) return "high";
  return "very_high";
}

/** Expected visible output tokens, from measurement where available, else the caller's own cap or a task-shaped default. */
export function estimateVisibleOutputTokens({ taskProfile, telemetry = null, minimumSamplesForMeasuredEstimate = 10 } = {}) {
  const measured = Number(telemetry?.observedVisibleOutputTokens);
  const samples = Number(telemetry?.sampleCount ?? 0);
  if (Number.isFinite(measured) && measured > 0 && samples >= minimumSamplesForMeasuredEstimate) {
    return { expectedVisibleOutputTokens: Math.round(measured), source: "measured_history" };
  }
  if (Number.isFinite(taskProfile?.requestedMaxOutputTokens) && taskProfile.requestedMaxOutputTokens > 0) {
    return { expectedVisibleOutputTokens: taskProfile.requestedMaxOutputTokens, source: "request_max_tokens" };
  }
  const byWork = {
    quick: 200,
    explain: 800,
    documentation: 1200,
    code: 1200,
    debug: 1000,
    review: 1000,
    planning: 1200,
    architecture: 2000,
    data_analysis: 1000,
    unknown: 800
  };
  const base = byWork[taskProfile?.workType] ?? 800;
  const complexityScale = { trivial: 0.4, normal: 1, complex: 1.6, extreme: 2.4 }[taskProfile?.complexity] ?? 1;
  return { expectedVisibleOutputTokens: Math.round(base * complexityScale), source: "task_profile_default" };
}

function priceNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Full effective-cost estimate for one candidate.
 *
 * Returns monetary cost and quota burn as **separate** figures plus a
 * combined `estimatedTotalResourceCost` in normalized units, so a
 * subscription-backed provider is never reported as free.
 */
export function estimateEffectiveCost({
  provider,
  isHttpProvider = false,
  executionProfile,
  taskProfile,
  benchmarkPricing = null,
  telemetry = null,
  estimatedInputTokens = 0,
  minimumSamplesForMeasuredEstimate = 10,
  quotaScarcity = 0
} = {}) {
  const { expectedVisibleOutputTokens, source: outputSource } = estimateVisibleOutputTokens({
    taskProfile,
    telemetry,
    minimumSamplesForMeasuredEstimate
  });

  const reasoning = estimateReasoningTokens({
    reasoningEffort: executionProfile?.reasoningEffort ?? "unknown",
    expectedVisibleOutputTokens,
    telemetry,
    minimumSamplesForMeasuredEstimate
  });

  const input = Math.max(0, Number(estimatedInputTokens) || 0);
  const reasoningTokens = reasoning.expectedReasoningTokens ?? 0;
  const effectiveExpectedTokens = input + expectedVisibleOutputTokens + reasoningTokens;

  // --- monetary
  const promptPrice = priceNumber(benchmarkPricing?.prompt);
  const completionPrice = priceNumber(benchmarkPricing?.completion) ?? promptPrice;
  const cacheReadPrice = priceNumber(benchmarkPricing?.input_cache_read ?? benchmarkPricing?.cache_read);
  const reasoningPrice = priceNumber(benchmarkPricing?.internal_reasoning ?? benchmarkPricing?.reasoning) ?? completionPrice;

  let estimatedMonetaryCost = null;
  let monetaryConfidence = "none";
  if (promptPrice != null) {
    estimatedMonetaryCost =
      input * promptPrice + expectedVisibleOutputTokens * (completionPrice ?? promptPrice) + reasoningTokens * (reasoningPrice ?? promptPrice);
    monetaryConfidence = reasoning.reasoningCostConfidence === "high" ? "medium" : "low";
  }

  // --- quota
  // Subscription providers: the scarce resource is the allowance, not
  // dollars. Burn is proportional to total tokens including reasoning,
  // which is precisely what a `max` profile inflates.
  const isSubscription = !isHttpProvider && SUBSCRIPTION_PROVIDERS.has(provider);
  const measuredQuota = Number(telemetry?.averageQuotaBurn);
  const samples = Number(telemetry?.sampleCount ?? 0);
  let estimatedQuotaBurn = 0;
  let quotaSource = "not_applicable";
  if (isSubscription) {
    if (Number.isFinite(measuredQuota) && measuredQuota > 0 && samples >= minimumSamplesForMeasuredEstimate) {
      estimatedQuotaBurn = measuredQuota;
      quotaSource = "measured_history";
    } else {
      // Normalized "allowance units" = total tokens per 1k. Deliberately a
      // relative scale, not a claim about the provider's real accounting.
      estimatedQuotaBurn = effectiveExpectedTokens / 1000;
      quotaSource = "token_proportional_prior";
    }
  }
  const quotaScarcityPenalty = estimatedQuotaBurn * Math.max(0, Number(quotaScarcity) || 0);

  // --- combined
  // Normalization: monetary cost in dollars is scaled up so that typical
  // per-request dollars and per-request quota units land on a comparable
  // axis. Exposed as a named constant rather than buried so it can be
  // recalibrated from shadow evidence.
  const MONETARY_TO_RESOURCE_UNITS = 1000;
  const monetaryUnits = estimatedMonetaryCost != null ? estimatedMonetaryCost * MONETARY_TO_RESOURCE_UNITS : 0;
  const estimatedTotalResourceCost = monetaryUnits + estimatedQuotaBurn + quotaScarcityPenalty;

  // Retry/failure expectation from real outcome history.
  const failureRate = Number(telemetry?.failureRate);
  const expectedRetryCostMultiplier = Number.isFinite(failureRate) && failureRate > 0 && samples >= minimumSamplesForMeasuredEstimate ? 1 + failureRate : 1;

  const speedSurchargeApplied = executionProfile?.speedMode === "fast" || executionProfile?.speedMode === "priority";

  return {
    expectedInputTokens: input,
    expectedVisibleOutputTokens,
    expectedVisibleOutputSource: outputSource,
    ...reasoning,
    effectiveExpectedTokens,

    estimatedMonetaryCost,
    monetaryCostConfidence: monetaryConfidence,
    pricingAvailable: promptPrice != null,
    cacheReadPriceKnown: cacheReadPrice != null,

    isSubscriptionProvider: isSubscription,
    estimatedQuotaBurn,
    quotaBurnSource: quotaSource,
    quotaScarcityPenalty,

    expectedRetryCostMultiplier,
    speedSurchargeApplied,

    estimatedTotalResourceCost: estimatedTotalResourceCost * expectedRetryCostMultiplier,
    costUncertainty: costUncertainty({ reasoning, monetaryConfidence, isSubscription, quotaSource })
  };
}

/** 0..1 — how much of this cost estimate rests on priors rather than measurement. */
function costUncertainty({ reasoning, monetaryConfidence, isSubscription, quotaSource }) {
  let penalty = 0;
  if (reasoning.reasoningEstimateSource === "unknown") penalty += 0.5;
  else if (reasoning.reasoningEstimateSource === "ordinal_prior") penalty += 0.3;
  if (monetaryConfidence === "none") penalty += 0.2;
  else if (monetaryConfidence === "low") penalty += 0.1;
  if (isSubscription && quotaSource === "token_proportional_prior") penalty += 0.2;
  return Math.min(1, penalty);
}

/**
 * How well a candidate's reasoning profile fits the task's reasoning demand.
 * Returns a signed alignment in [-1, 1] plus a rationale — transparent
 * priors, superseded by measured outcomes once telemetry is dense enough
 * (see expectedUtility.js, which prefers measured quality when available).
 *
 * Explicitly two-sided: over-reasoning a trivial task is a cost defect, and
 * under-reasoning a hard task is a quality defect. Higher reasoning is never
 * treated as automatically better.
 */
export function reasoningFit({ reasoningEffort, reasoningDemand }) {
  const effortRank = reasoningEffortRank(reasoningEffort);
  const demandRank = ["minimal", "low", "medium", "high", "maximum"].indexOf(reasoningDemand);
  if (effortRank == null || demandRank === -1) {
    return { alignment: 0, reason: "reasoning effort or demand unknown — no fit adjustment applied" };
  }
  // Map effort (0..6 over none..max) onto the 0..4 demand scale.
  const effortOnDemandScale = (effortRank / 6) * 4;
  const delta = effortOnDemandScale - demandRank;
  if (Math.abs(delta) <= 0.5) {
    return { alignment: 1, reason: `reasoning effort ${reasoningEffort} matches ${reasoningDemand} demand` };
  }
  if (delta > 0) {
    return {
      alignment: -Math.min(1, (delta - 0.5) / 3),
      reason: `reasoning effort ${reasoningEffort} exceeds ${reasoningDemand} demand — pays cost and latency for reasoning the task does not need`
    };
  }
  return {
    alignment: -Math.min(1, (Math.abs(delta) - 0.5) / 3),
    reason: `reasoning effort ${reasoningEffort} is below ${reasoningDemand} demand — quality risk`
  };
}
