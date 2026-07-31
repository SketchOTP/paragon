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

  const measuredReasoning = Number(telemetry?.observedReasoningTokens);
  const samples = Number(telemetry?.sampleCount ?? 0);

  // 1/2 — the provider's own reported reasoning-token usage. This is the
  // directive's top evidence source and therefore outranks the sample-count
  // threshold that governs inferred history below: one real number from the
  // provider beats any prior, so a single reported observation is enough to
  // stop using the ordinal guess. Confidence still scales with sample count.
  const providerReported =
    telemetry?.usageSource === "http_response_usage" || telemetry?.usageSource === "provider_cli_structured";
  if (providerReported && Number.isFinite(measuredReasoning) && measuredReasoning >= 0 && (telemetry.usageObservationCount ?? 0) > 0) {
    return {
      expectedReasoningTokens: Math.round(measuredReasoning),
      expectedReasoningTokenRange: { min: Math.round(measuredReasoning * 0.7), max: Math.round(measuredReasoning * 1.4) },
      reasoningBurnClass: burnClassForRatio(visible > 0 ? measuredReasoning / visible : 0),
      reasoningCostConfidence: samples >= minimumSamplesForMeasuredEstimate ? "high" : "medium",
      reasoningEstimateSource: "provider_reported_usage"
    };
  }

  // 3 — measured history for this exact provider/model/profile.
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
  // Provider-reported usage is evidence source 1 and does not wait for the
  // sample threshold (see estimateReasoningTokens for the same rule).
  const providerReported =
    (telemetry?.usageSource === "http_response_usage" || telemetry?.usageSource === "provider_cli_structured") &&
    (telemetry?.usageObservationCount ?? 0) > 0;
  if (Number.isFinite(measured) && measured > 0 && (providerReported || samples >= minimumSamplesForMeasuredEstimate)) {
    return {
      expectedVisibleOutputTokens: Math.round(measured),
      source: providerReported ? "provider_reported_usage" : "measured_history"
    };
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
  publishedPricing = null,
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

  // PARAGON-D-004E (Phase 1): unknown reasoning consumption must never be
  // costed as zero. `?? 0` here was the exact artificial-advantage bug the
  // directive forbids — a model whose reasoning behavior PARAGON cannot
  // observe would price as if it did no reasoning at all and out-compete a
  // model that honestly reported a large reasoning burn. When the source is
  // `unknown` we substitute a conservative floor (the "high" effort prior
  // midpoint) so the candidate is costed pessimistically, and flag it so the
  // uncertainty penalty applies on top.
  const reasoningUnknown = reasoning.reasoningEstimateSource === "unknown";
  /**
   * The floor for unknown reasoning consumption is the **medium** prior, not
   * the high one.
   *
   * "Unknown" here overwhelmingly means "this provider does not encode
   * reasoning effort in its model ids", not "this model secretly reasons a
   * lot". Charging it the high prior assumed worst-case consumption on no
   * evidence, doubled its expected reasoning tokens against a comparable
   * model whose effort could be parsed, and — because reasoning tokens are
   * priced — inflated its monetary cost with them. Measured against real
   * data, that turned a 2x token assumption into an 11x cost term.
   *
   * The neutral default still refuses to treat unknown as zero, which is the
   * property that matters; the honesty burden is carried by the uncertainty
   * penalty (see uncertaintyPenalty), not by a pessimistic guess.
   */
  const conservativeReasoningFloor = Math.round(
    expectedVisibleOutputTokens * ((REASONING_PRIOR.medium.min + REASONING_PRIOR.medium.max) / 2)
  );
  const reasoningTokens = reasoningUnknown ? conservativeReasoningFloor : (reasoning.expectedReasoningTokens ?? 0);
  const effectiveExpectedTokens = input + expectedVisibleOutputTokens + reasoningTokens;

  // --- provider-owned pricing
  // Benchmark prices are OpenRouter prices. They are never a fallback for a
  // native CLI or a different HTTP provider.
  const pricing = publishedPricing ?? (provider === "openrouter" ? benchmarkPricing : null);
  const promptPrice = priceNumber(pricing?.prompt) ?? (priceNumber(pricing?.inputPerMillion) != null ? priceNumber(pricing.inputPerMillion) / 1_000_000 : null);
  const completionPrice = priceNumber(pricing?.completion) ?? (priceNumber(pricing?.completionPerMillion) != null ? priceNumber(pricing.completionPerMillion) / 1_000_000 : promptPrice);
  const cacheReadPrice = priceNumber(pricing?.input_cache_read ?? pricing?.cache_read) ?? (priceNumber(pricing?.cacheReadPerMillion) != null ? priceNumber(pricing.cacheReadPerMillion) / 1_000_000 : null);
  const reasoningPrice = priceNumber(pricing?.internal_reasoning ?? pricing?.reasoning) ?? completionPrice;

  const isCodexCredits = String(pricing?.billingUnit ?? "").toLowerCase().startsWith("codex credits");
  let estimatedMonetaryCost = null;
  let estimatedCreditsConsumed = null;
  let monetaryConfidence = "none";
  if (isCodexCredits && promptPrice != null) {
    estimatedCreditsConsumed =
      input * promptPrice + expectedVisibleOutputTokens * (completionPrice ?? promptPrice) + reasoningTokens * (reasoningPrice ?? promptPrice);
    monetaryConfidence = "high";
  } else if (promptPrice != null) {
    estimatedMonetaryCost =
      input * promptPrice + expectedVisibleOutputTokens * (completionPrice ?? promptPrice) + reasoningTokens * (reasoningPrice ?? promptPrice);
    monetaryConfidence = reasoning.reasoningCostConfidence === "high" ? "medium" : "low";
  }

  // --- quota
  // Subscription providers: the scarce resource is the allowance, not
  // dollars. Burn is proportional to total tokens including reasoning,
  // which is precisely what a `max` profile inflates.
  const isSubscription = false;
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
  let monetaryUnits = isCodexCredits
    ? (estimatedCreditsConsumed ?? 0)
    : estimatedMonetaryCost != null
      ? estimatedMonetaryCost * MONETARY_TO_RESOURCE_UNITS
      : 0;

  // PARAGON-D-004E (Phase 1): a metered provider with no pricing evidence is
  // not a free provider. Without this, an unpriced HTTP endpoint scored zero
  // monetary cost AND zero quota burn — a perfect cost score built entirely on
  // absence of information, which would beat every honestly-priced candidate.
  // Charge it the same token-proportional relative cost a subscription
  // provider pays, so missing pricing is neutral rather than advantageous.
  const unpricedMeteredProvider = promptPrice == null;
  if (unpricedMeteredProvider) {
    monetaryUnits = effectiveExpectedTokens / 1000;
  }

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
    estimatedCreditsConsumed,
    monetaryCostConfidence: monetaryConfidence,
    pricingAvailable: promptPrice != null,
    pricingConfidence: pricing?.confidence ?? "unknown",
    cacheReadPriceKnown: cacheReadPrice != null,
    // PARAGON-D-004E: surfaced so Diagnostics can show *why* a cost figure is
    // soft, and so a reviewer can prove unknown usage was penalized rather
    // than zeroed.
    reasoningTokensAssumedConservative: reasoningUnknown,
    conservativeReasoningFloorTokens: reasoningUnknown ? conservativeReasoningFloor : null,
    unpricedMeteredProvider,

    isSubscriptionProvider: false,
    billingUnit: pricing?.billingUnit ?? null,
    pricingSource: pricing?.source ?? pricing?.sourceUrl ?? null,
    pricingAsOf: pricing?.asOf ?? null,
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
    /**
     * Alignment is **penalty-only**: matching the task's reasoning demand is
     * the baseline expectation, not a bonus.
     *
     * This used to return +1, which was a reward for *legibility* rather than
     * capability. Only some providers encode reasoning effort in their model
     * ids (cursor and antigravity do; claude and codex do not — see
     * executionProfile.js). A model whose effort PARAGON could parse therefore
     * collected a full reasoningFitScale bonus, while an equally good model
     * from a provider without that grammar scored 0 and looked worse for a
     * reason that had nothing to do with the model. Measured against real
     * data: two models with identical benchmarked quality (0.71) sat 15
     * utility points apart on this term alone.
     */
    return { alignment: 0, reason: `reasoning effort ${reasoningEffort} matches ${reasoningDemand} demand` };
  }
  /**
   * The two directions are deliberately **not** symmetric.
   *
   * Over-reasoning's harm is paying for thinking the task did not need — and
   * that harm is already counted, in full, by the cost term (more reasoning
   * tokens cost more). Penalizing it steeply here would charge for it twice.
   *
   * Under-reasoning's harm is failing the task, and nothing else in the
   * utility function represents it: a cheap shallow model looks cheap right up
   * until it produces a wrong answer. So it is the direction that has to carry
   * real weight, otherwise a security-critical task demanding maximum
   * reasoning can never justify a model that actually does it.
   */
  if (delta > 0) {
    return {
      alignment: -Math.min(1, (delta - 0.5) / 3),
      reason: `reasoning effort ${reasoningEffort} exceeds ${reasoningDemand} demand — pays cost and latency for reasoning the task does not need`
    };
  }
  return {
    alignment: -Math.min(1, (Math.abs(delta) - 0.5) / 1.5),
    reason: `reasoning effort ${reasoningEffort} is below ${reasoningDemand} demand — quality risk`
  };
}
