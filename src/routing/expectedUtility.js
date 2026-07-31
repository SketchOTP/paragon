/**
 * Expected-utility routing (PARAGON-D-004D, Phases 8 and 10).
 *
 * Replaces additive label scoring (+3 taskRoute, +2 cost-class match, ±8
 * benchmark value) with an explicit decomposition:
 *
 *   expectedUtility =
 *       probabilityOfSuccessfulCompletion * expectedTaskQuality
 *     - expectedTotalResourceCost
 *     - expectedLatencyPenalty
 *     - expectedQuotaScarcityPenalty
 *     - uncertaintyPenalty
 *
 * Every component is returned separately. Nothing is hidden behind one
 * unexplained number, because the previous design's opacity is what let a
 * misattributed benchmark dominate for weeks without being noticed.
 *
 * Hard eligibility stays strictly separate from scoring: a candidate is
 * either admissible or it is not, and scoring never rescues an inadmissible
 * one (that separation is the D-004C1 integrity guarantee).
 */

import { estimateEffectiveCost, reasoningFit } from "./costModel.js";
import { checkRequiredCapabilities } from "./capabilityProfile.js";
import { checkContextFit } from "./contextModel.js";
import { isCircuitOpen, circuitStateSnapshot } from "../orchestration/liveEnforcement.js";

export const CONFIDENCE_LEVELS = ["high", "medium", "low", "only_eligible", "explicit_validated"];

/**
 * Weights converting each component onto the utility axis. Named and exported
 * so the dashboard can display them and so shadow-mode evidence can
 * recalibrate them — deliberately not buried as literals inside the formula.
 *
 * Quality is the 0..1 quality estimate scaled to this range; costs are in
 * normalized resource units (see costModel) scaled down to be comparable.
 */
export const UTILITY_WEIGHTS = {
  qualityScale: 100,
  resourceCostScale: 0.5,
  latencyPenaltyScale: 8,
  quotaScarcityScale: 1.0,
  uncertaintyScale: 20,
  reasoningFitScale: 15,
  /** Provider preference is configured separately from evidence weights. */
  providerPreferenceScale: 3
};

/** Neutral prior when there is no measured success history at all. */
const PRIOR_SUCCESS_PROBABILITY = 0.85;

/**
 * Quality priors by benchmark index, normalized to 0..1. Only used when a
 * confident benchmark match exists; measured outcome quality outranks it.
 */
function qualityFromBenchmark(benchmark, taskProfile) {
  if (!benchmark?.row) return null;
  const codingTasks = new Set(["code", "debug", "review"]);
  const row = benchmark.row;
  const index = codingTasks.has(taskProfile?.workType)
    ? (row.coding_index ?? row.intelligence_index)
    : (row.intelligence_index ?? row.coding_index);
  if (index == null || !Number.isFinite(Number(index))) return null;
  // Published indices sit roughly in 0..100; clamp rather than assume.
  return Math.max(0, Math.min(1, Number(index) / 100));
}

/**
 * Quality from measured outcomes: structured-output compliance is the one
 * output-contract signal PARAGON can verify itself, so it is the strongest
 * available quality evidence when the caller asked for structured output.
 */
function qualityFromTelemetry(telemetry, taskProfile, minimumSamples) {
  if (!telemetry || telemetry.sampleCount < minimumSamples) return null;
  const wantsStructured = taskProfile?.outputContract === "json" || taskProfile?.outputContract === "json_schema";
  if (wantsStructured && telemetry.jsonComplianceRate != null) {
    return Math.max(0, Math.min(1, telemetry.jsonComplianceRate));
  }
  return null;
}

/** Explicit task-profile prior, used only when neither measurement nor benchmark exists. */
function qualityFromTaskPrior(taskProfile) {
  const byPreference = { economy: 0.55, balanced: 0.65, maximum: 0.7 };
  return byPreference[taskProfile?.qualityPreference] ?? 0.6;
}

function latencyPenalty({ telemetry, taskProfile, executionProfile, minimumSamples }) {
  const preference = taskProfile?.latencyPreference ?? "normal";
  const weight = preference === "interactive" ? 1 : preference === "batch" ? 0.1 : 0.4;

  const measured = telemetry?.completionLatencyP95;
  if (Number.isFinite(measured) && telemetry.sampleCount >= minimumSamples) {
    // Normalize against a 30s reference; a 30s p95 costs one full unit.
    return { penalty: weight * Math.min(2, measured / 30000), source: "measured_p95", measuredP95Ms: measured };
  }

  // No measurement: use the transparent prior that higher reasoning effort
  // takes longer, and that a `fast` speed mode reduces latency.
  const effortLatencyPrior = { none: 0.05, minimal: 0.1, low: 0.2, medium: 0.4, high: 0.7, xhigh: 1.0, max: 1.3, unknown: 0.4 };
  const base = effortLatencyPrior[executionProfile?.reasoningEffort ?? "unknown"] ?? 0.4;
  const speedFactor = executionProfile?.speedMode === "fast" ? 0.6 : executionProfile?.speedMode === "priority" ? 0.7 : 1;
  return { penalty: weight * base * speedFactor, source: "effort_prior", measuredP95Ms: null };
}

/**
 * Hard eligibility. Every D-004C1 gate is preserved, plus the new capability
 * and practical-context gates. Returns the first failure so the dashboard
 * can show a specific exclusion reason.
 */
export function checkHardEligibility(candidate, { taskProfile, unknownLargeContextThresholdTokens, maxCostClass, quotaState = null }) {
  if (candidate.pendingAssessment) {
    return { ok: false, reasonCode: "routing.providerPendingAssessment" };
  }
  if (!candidate.providerModelId) {
    return { ok: false, reasonCode: "eligibility.noModelResolved" };
  }
  if (!candidate.catalogEligible) {
    return { ok: false, reasonCode: "eligibility.automaticEligibilityDisabled" };
  }
  if (candidate.health === "unhealthy") {
    return { ok: false, reasonCode: "eligibility.unhealthyProvider" };
  }
  if (isCircuitOpen(candidate.provider)) {
    return { ok: false, reasonCode: "eligibility.circuitOpen" };
  }
  // PARAGON-D-004E (Phase 1): a provider whose allowance is observably spent
  // is inadmissible until its known reset, not merely expensive. Scoring must
  // never be able to rescue it — that is what let an exhausted provider keep
  // being attempted (and keep failing) once per request.
  if (quotaState?.isExhausted?.(candidate.provider)) {
    const state = quotaState.state?.(candidate.provider) ?? null;
    return {
      ok: false,
      reasonCode: "eligibility.quotaExhausted",
      detail: state?.resetAt ? `provider allowance exhausted; expected reset ${state.resetAt}` : "provider allowance exhausted"
    };
  }

  const capability = checkRequiredCapabilities(candidate.capabilities, taskProfile?.requiredCapabilities ?? []);
  if (!capability.ok) {
    return { ok: false, reasonCode: capability.reasonCode, detail: `requires ${capability.requirement}, observed ${capability.observed}` };
  }

  const contextFit = checkContextFit({
    contextModel: candidate.contextModel,
    estimatedInputTokens: taskProfile?.estimatedInputTokens ?? 0,
    requiredOutputTokens: candidate.contextModel?.outputTokenReserve ?? 0,
    unknownLargeContextThresholdTokens
  });
  if (!contextFit.ok) {
    return { ok: false, reasonCode: contextFit.reasonCode, detail: contextFit.detail };
  }

  if (maxCostClass) {
    const order = ["economy", "standard", "premium"];
    if (order.indexOf(candidate.costClass) > order.indexOf(maxCostClass)) {
      return { ok: false, reasonCode: "eligibility.costCeilingExceeded" };
    }
  }

  return { ok: true, unknownContext: Boolean(contextFit.unknownContext) };
}

/**
 * Scores one admissible candidate. Returns the full component breakdown.
 */
export function scoreCandidate(candidate, { taskProfile, weights = UTILITY_WEIGHTS, minimumSamplesForMeasuredEstimate = 10, quotaScarcity = 0, unknownContext = false, providerPreferencePoints = {}, providerPreferenceScale = 3 }) {
  const telemetry = candidate.telemetry ?? null;
  // Routing priority resolves to a weight set (see routingPriority.js). It can
  // only reorder admissible candidates — hard eligibility was already decided.
  const W = { ...UTILITY_WEIGHTS, ...weights };

  // --- probability of successful completion
  let probabilityOfSuccessfulCompletion = PRIOR_SUCCESS_PROBABILITY;
  let successSource = "prior";
  if (telemetry?.smoothedSuccessProbability != null && telemetry.sampleCount > 0) {
    probabilityOfSuccessfulCompletion = telemetry.smoothedSuccessProbability;
    successSource = telemetry.sampleCount >= minimumSamplesForMeasuredEstimate ? "measured" : "measured_sparse";
  }

  // --- expected task quality
  const measuredQuality = qualityFromTelemetry(telemetry, taskProfile, minimumSamplesForMeasuredEstimate);
  const benchmarkQuality = qualityFromBenchmark(candidate.benchmark, taskProfile);
  let expectedTaskQuality;
  let qualitySource;
  if (measuredQuality != null) {
    expectedTaskQuality = measuredQuality;
    qualitySource = "measured_outcomes";
  } else if (benchmarkQuality != null) {
    expectedTaskQuality = benchmarkQuality;
    qualitySource = candidate.benchmark.matchMethod === "canonical_model" ? "benchmark_canonical_base" : "benchmark_exact";
  } else {
    expectedTaskQuality = qualityFromTaskPrior(taskProfile);
    qualitySource = "task_profile_prior";
  }

  // --- cost
  const cost = estimateEffectiveCost({
    provider: candidate.provider,
    isHttpProvider: candidate.isHttpProvider,
    executionProfile: candidate.executionProfile,
    taskProfile,
    // Benchmark rows are quality evidence. Their pricing is provider-owned
    // and may only price an OpenRouter tuple.
    benchmarkPricing: candidate.provider === "openrouter" ? candidate.benchmark?.row?.pricing ?? null : null,
    publishedPricing: candidate.publishedPricing ?? null,
    telemetry,
    estimatedInputTokens: taskProfile?.estimatedInputTokens ?? 0,
    minimumSamplesForMeasuredEstimate,
    quotaScarcity
  });

  // --- latency
  const latency = latencyPenalty({ telemetry, taskProfile, executionProfile: candidate.executionProfile, minimumSamples: minimumSamplesForMeasuredEstimate });

  // --- reasoning fit (two-sided: over- and under-reasoning both penalized)
  const fit = reasoningFit({
    reasoningEffort: candidate.executionProfile?.reasoningEffort ?? "unknown",
    reasoningDemand: taskProfile?.reasoningDemand ?? "medium"
  });

  // --- uncertainty
  const uncertainty = uncertaintyPenalty({ candidate, telemetry, cost, unknownContext, minimumSamplesForMeasuredEstimate });

  const costSensitivityScale = { low: 0.6, normal: 1, high: 1.8 }[taskProfile?.costSensitivity] ?? 1;

  // Post-verified capabilities (structured output) are not hard gates — see
  // taskProfile.js. A candidate with *positive* evidence for one still deserves
  // to be preferred, so it is a bounded scoring term rather than an exclusion.
  // A candidate with `unknown` is neither rewarded nor punished: PARAGON will
  // verify the actual response and escalate if it is wrong.
  let postVerifiedBonus = 0;
  const postVerifiedReasons = [];
  for (const capability of taskProfile?.postVerifiedCapabilities ?? []) {
    if (candidate.capabilities?.[capability] === true) {
      postVerifiedBonus += 2;
      postVerifiedReasons.push(`${capability} positively supported`);
    } else if (candidate.capabilities?.[capability] === false) {
      postVerifiedBonus -= 4;
      postVerifiedReasons.push(`${capability} positively unsupported`);
    }
  }

  const qualityTerm = probabilityOfSuccessfulCompletion * expectedTaskQuality * W.qualityScale;
  const costTerm = cost.estimatedTotalResourceCost * W.resourceCostScale * costSensitivityScale;
  const latencyTerm = latency.penalty * W.latencyPenaltyScale;
  const quotaTerm = cost.quotaScarcityPenalty * W.quotaScarcityScale;
  const uncertaintyTerm = uncertainty.penalty * W.uncertaintyScale;
  const reasoningFitTerm = fit.alignment * W.reasoningFitScale;
  const configuredProviderPreference = Number(providerPreferencePoints?.[candidate.provider] ?? 0) || 0;
  const preferenceScale = Number(providerPreferenceScale ?? W.providerPreferenceScale ?? 3) || 0;
  const providerPreferenceTerm = configuredProviderPreference * preferenceScale;

  const expectedUtility =
    qualityTerm - costTerm - latencyTerm - quotaTerm - uncertaintyTerm + reasoningFitTerm + postVerifiedBonus + providerPreferenceTerm;

  return {
    provider: candidate.provider,
    providerModelId: candidate.providerModelId,
    canonicalModelId: candidate.executionProfile?.canonicalModelId ?? candidate.providerModelId,
    isHttpProvider: candidate.isHttpProvider,
    executionMethod: candidate.executionMethod,
    executionPath: candidate.executionPath,
    expertId: candidate.expertId,
    reasoningEffort: candidate.executionProfile?.reasoningEffort ?? "unknown",
    speedMode: candidate.executionProfile?.speedMode ?? "unknown",
    executionProfile: candidate.executionProfile?.executionProfile ?? "unknown",
    // Carried through so response headers and Diagnostics can report catalog
    // provenance without re-deriving the registry a second time.
    modelState: candidate.modelState ?? null,
    costClass: candidate.costClass ?? null,
    excluded: false,

    expectedUtility,
    components: {
      probabilityOfSuccessfulCompletion,
      successSource,
      expectedTaskQuality,
      qualitySource,
      qualityTerm,
      expectedTotalResourceCost: cost.estimatedTotalResourceCost,
      costTerm,
      expectedLatencyPenalty: latency.penalty,
      latencyTerm,
      latencySource: latency.source,
      measuredLatencyP95Ms: latency.measuredP95Ms,
      expectedQuotaScarcityPenalty: cost.quotaScarcityPenalty,
      quotaTerm,
      uncertaintyPenalty: uncertainty.penalty,
      uncertaintyTerm,
      uncertaintyReasons: uncertainty.reasons,
      reasoningFitAlignment: fit.alignment,
      reasoningFitReason: fit.reason,
      reasoningFitTerm,
      postVerifiedBonus,
      postVerifiedReasons,
      configuredProviderPreference,
      providerPreferenceScale: preferenceScale,
      providerPreferenceTerm,
      // Backward-compatible diagnostic alias; both values come from the same
      // term and cannot diverge.
      providerPreferenceBonus: providerPreferenceTerm,
      // The weight set this candidate was scored with, so Diagnostics can
      // prove which routing priority produced a given ordering.
      appliedWeights: W
    },
    cost,
    contextModel: candidate.contextModel,
    capabilities: candidate.capabilities,
    benchmark: candidate.benchmark
      ? {
          matchMethod: candidate.benchmark.matchMethod,
          matchConfidence: candidate.benchmark.matchConfidence,
          matchedBenchmarkModel: candidate.benchmark.matchedBenchmarkModel,
          appliesToCanonicalModel: candidate.benchmark.appliesToCanonicalModel ?? null
        }
      : { matchMethod: "none", matchConfidence: "none", matchedBenchmarkModel: null },
    telemetry: telemetry
      ? {
          sampleCount: telemetry.sampleCount,
          measurementConfidence: telemetry.measurementConfidence,
          successRate: telemetry.successRate,
          jsonComplianceRate: telemetry.jsonComplianceRate,
          lastSuccessAt: telemetry.lastSuccessAt,
          source: telemetry.source
        }
      : { sampleCount: 0, measurementConfidence: "none" },
    // Share of utility magnitude derived from measurement rather than priors.
    measuredEvidenceShare: measuredEvidenceShare({ successSource, qualitySource, cost, latency })
  };
}

function uncertaintyPenalty({ candidate, telemetry, cost, unknownContext, minimumSamplesForMeasuredEstimate }) {
  let penalty = 0;
  const reasons = [];

  if (unknownContext || candidate.contextModel?.effectiveUsableContextWindow == null) {
    penalty += 0.25;
    reasons.push("context capacity unknown");
  } else if (candidate.contextModel.contextConfidence === "low") {
    penalty += 0.1;
    reasons.push("context capacity from public documentation only");
  }

  const unknownCaps = Object.entries(candidate.capabilities ?? {}).filter(([, v]) => v === "unknown").length;
  if (unknownCaps > 0) {
    penalty += Math.min(0.2, unknownCaps * 0.04);
    reasons.push(`${unknownCaps} capability field(s) unknown`);
  }

  if (!telemetry || telemetry.sampleCount === 0) {
    penalty += 0.25;
    reasons.push("no outcome telemetry");
  } else if (telemetry.sampleCount < minimumSamplesForMeasuredEstimate) {
    penalty += 0.15;
    reasons.push(`only ${telemetry.sampleCount} sample(s)`);
  }

  if (cost.reasoningEstimateSource === "unknown") {
    penalty += 0.2;
    reasons.push("reasoning-token consumption unknown");
  } else if (cost.reasoningEstimateSource === "ordinal_prior") {
    penalty += 0.1;
    reasons.push("reasoning-token consumption from ordinal prior");
  }

  if (candidate.benchmark?.matchMethod === "none") {
    penalty += 0.05;
    reasons.push("no benchmark evidence");
  } else if (candidate.benchmark?.matchMethod === "canonical_model") {
    penalty += 0.05;
    reasons.push("benchmark describes the canonical base model, not this execution profile");
  }

  return { penalty: Math.min(1.5, penalty), reasons };
}

function measuredEvidenceShare({ successSource, qualitySource, cost, latency }) {
  let measured = 0;
  let total = 0;
  const add = (isMeasured) => {
    total += 1;
    if (isMeasured) measured += 1;
  };
  add(successSource === "measured");
  add(qualitySource === "measured_outcomes");
  add(cost.reasoningEstimateSource === "measured_history" || cost.reasoningEstimateSource === "provider_reported_usage");
  add(cost.quotaBurnSource === "measured_history" || cost.quotaBurnSource === "not_applicable");
  add(latency.source === "measured_p95");
  return total ? measured / total : 0;
}

/**
 * Deterministic tie-break (Phase 10). Registry insertion order is never a
 * factor — that was an undocumented routing weight.
 */
export function compareCandidates(a, b) {
  const utilityDelta = b.expectedUtility - a.expectedUtility;
  if (Math.abs(utilityDelta) > 1e-9) return utilityDelta;

  const byEvidence = (b.components.successSource === "measured" ? 1 : 0) - (a.components.successSource === "measured" ? 1 : 0);
  if (byEvidence !== 0) return byEvidence;

  const bySuccess = b.components.probabilityOfSuccessfulCompletion - a.components.probabilityOfSuccessfulCompletion;
  if (Math.abs(bySuccess) > 1e-9) return bySuccess;

  const byCost = a.components.expectedTotalResourceCost - b.components.expectedTotalResourceCost;
  if (Math.abs(byCost) > 1e-9) return byCost;

  const aLat = a.components.measuredLatencyP95Ms ?? Infinity;
  const bLat = b.components.measuredLatencyP95Ms ?? Infinity;
  if (aLat !== bLat) return aLat - bLat;

  const byQuota = a.components.expectedQuotaScarcityPenalty - b.components.expectedQuotaScarcityPenalty;
  if (Math.abs(byQuota) > 1e-9) return byQuota;

  const aRecent = a.telemetry?.lastSuccessAt ? Date.parse(a.telemetry.lastSuccessAt) : 0;
  const bRecent = b.telemetry?.lastSuccessAt ? Date.parse(b.telemetry.lastSuccessAt) : 0;
  if (aRecent !== bRecent) return bRecent - aRecent;

  const confRank = { high: 3, medium: 2, low: 1, none: 0 };
  const byConf = (confRank[b.telemetry?.measurementConfidence] ?? 0) - (confRank[a.telemetry?.measurementConfidence] ?? 0);
  if (byConf !== 0) return byConf;

  // Final deterministic anchor: lexical, never insertion order.
  return `${a.provider}/${a.providerModelId}`.localeCompare(`${b.provider}/${b.providerModelId}`);
}

/**
 * Evidence-based routing confidence (Phase 10). Replaces the old binary
 * "more than one eligible candidate ⇒ scored", which reported the same
 * confidence for a 10-point lead and a 0-point tie.
 */
export function routingConfidence(ranked, { explicitlyForced = false } = {}) {
  const eligible = ranked.filter((c) => !c.excluded);
  if (!eligible.length) return { level: "low", margin: null, reasons: ["no eligible candidate"] };
  if (explicitlyForced) return { level: "explicit_validated", margin: null, reasons: ["explicitly forced and validated against the eligible registry"] };
  if (eligible.length === 1) return { level: "only_eligible", margin: null, reasons: ["exactly one eligible candidate"] };

  const winner = eligible[0];
  const runnerUp = eligible[1];
  const margin = winner.expectedUtility - runnerUp.expectedUtility;
  const spread = Math.max(1e-9, Math.abs(winner.expectedUtility) + Math.abs(runnerUp.expectedUtility)) / 2;
  const relativeMargin = margin / spread;

  const reasons = [];
  let score = 0;

  if (relativeMargin >= 0.15) { score += 2; reasons.push(`clear utility margin (${margin.toFixed(2)})`); }
  else if (relativeMargin >= 0.05) { score += 1; reasons.push(`moderate utility margin (${margin.toFixed(2)})`); }
  else { reasons.push(`narrow utility margin (${margin.toFixed(2)})`); }

  if (winner.measuredEvidenceShare >= 0.6) { score += 2; reasons.push("majority of utility from measured evidence"); }
  else if (winner.measuredEvidenceShare >= 0.3) { score += 1; reasons.push("partial measured evidence"); }
  else { reasons.push("utility is mostly heuristic priors"); }

  if (winner.telemetry?.measurementConfidence === "high") { score += 1; reasons.push("high telemetry confidence"); }
  if (winner.capabilities?.capabilityConfidence === "high") { score += 1; reasons.push("high capability confidence"); }
  if (winner.contextModel?.contextConfidence === "high") { score += 1; reasons.push("high context confidence"); }
  if (winner.benchmark?.matchConfidence === "high" && winner.benchmark.matchMethod !== "none") { score += 1; reasons.push("confident benchmark attribution"); }
  if (winner.components?.uncertaintyPenalty >= 0.6) { score -= 1; reasons.push("large uncertainty penalty"); }

  let level = score >= 5 ? "high" : score >= 3 ? "medium" : "low";

  // Margin cap. Confidence describes the *decision*, not how well the
  // candidates are characterized: if the winner leads by a fraction of a
  // percent, the choice between the top two is close to arbitrary no matter
  // how much capability/context/benchmark evidence exists for each. Without
  // this cap, two thoroughly-described near-identical candidates reported
  // "medium" on what is effectively a coin flip.
  if (relativeMargin < 0.05) {
    level = "low";
    reasons.push("capped to low: winner and runner-up are within 5% of each other, so the choice between them is not evidence-backed");
  }

  return { level, margin, relativeMargin, evidenceScore: score, reasons };
}

/**
 * Full ranking pass: hard-filter, score, sort with explicit tie-breaks.
 */
export function rankCandidates(candidates, options) {
  const scored = [];
  for (const candidate of candidates) {
    const eligibility = checkHardEligibility(candidate, options);
    if (!eligibility.ok) {
      scored.push({
        provider: candidate.provider,
        providerModelId: candidate.providerModelId,
        canonicalModelId: candidate.executionProfile?.canonicalModelId ?? candidate.providerModelId ?? null,
        isHttpProvider: candidate.isHttpProvider,
        executionMethod: candidate.executionMethod,
        executionPath: candidate.executionPath,
        expertId: candidate.expertId,
        reasoningEffort: candidate.executionProfile?.reasoningEffort ?? "unknown",
        speedMode: candidate.executionProfile?.speedMode ?? "unknown",
        excluded: true,
        reasonCode: eligibility.reasonCode,
        detail: eligibility.detail ?? null,
        expectedUtility: null
      });
      continue;
    }
    scored.push(scoreCandidate(candidate, { ...options, unknownContext: eligibility.unknownContext }));
  }

  const eligible = scored.filter((c) => !c.excluded).sort(compareCandidates);
  const excluded = scored.filter((c) => c.excluded);
  const ranked = [...eligible, ...excluded];
  eligible.forEach((c, index) => {
    c.rank = index + 1;
    c.of = eligible.length;
  });

  return {
    ranked,
    winner: eligible[0] ?? null,
    confidence: routingConfidence(ranked, { explicitlyForced: Boolean(options?.explicitlyForced) }),
    circuitStates: circuitStateSnapshot(),
    weights: { ...UTILITY_WEIGHTS, ...(options?.weights ?? {}) }
  };
}
