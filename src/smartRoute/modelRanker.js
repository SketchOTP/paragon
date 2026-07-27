import { hasKnownPricing, pricingBlocksCostSensitiveRoute } from "./modelPricing.js";
import { taskQualityScore, usesSweBenchForTask } from "./modelBenchmarks.js";
import { shouldExcludeHealth } from "./modelHealthProbes.js";
import {
  effectiveReliability,
  requiresDirectHealth,
  resolveHealthMeta
} from "./modelHealthGroups.js";
import {
  getCheapTaskOptimization,
  isCostFloorTask,
  isPremiumModel,
  pricingConfidence
} from "./optimization.js";

export const TASK_FLOORS = {
  chat: { min_reliability: 0.9, min_quality: 0.3 },
  rewrite: { min_reliability: 0.92, min_quality: 0.35 },
  summarize: { min_reliability: 0.92, min_quality: 0.4 },
  extract: { min_reliability: 0.95, min_quality: 0.45, requires_json_probe: true },
  extract_json: { min_reliability: 0.95, min_quality: 0.45, requires_json_probe: true },
  code: { min_reliability: 0.9, min_quality: 0.55 },
  code_debug: { min_reliability: 0.92, min_quality: 0.65 },
  architecture: { min_reliability: 0.95, min_quality: 0.75 },
  high_stakes: { min_reliability: 0.97, min_quality: 0.8 }
};

const DEFAULT_INPUT_TOKENS = 800;
const DEFAULT_OUTPUT_TOKENS = 1200;

export function computeEffectiveCost(model, options = {}) {
  const pricing = model.pricing ?? {};
  const health = model.health ?? {};
  const inputTokens = options.inputTokens ?? DEFAULT_INPUT_TOKENS;
  const outputTokens = options.outputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const cachedTokens = options.cachedTokens ?? 0;

  const inputPrice = pricing.input_per_1m ?? 0;
  const cachedPrice = pricing.cached_input_per_1m ?? inputPrice * 0.1;
  const outputPrice = pricing.output_per_1m ?? 0;
  const toolCost = pricing.tool_call_cost ?? 0;

  let tokenCost =
    (inputTokens / 1_000_000) * inputPrice +
    (cachedTokens / 1_000_000) * cachedPrice +
    (outputTokens / 1_000_000) * outputPrice +
    toolCost;

  // Subscription CLIs may report $0 marginal tokens; use API-equivalent
  // fallback rates so benchmark:cost ratios stay meaningful.
  const billingModel = pricing.billing_model ?? "unknown";
  const isSubscription =
    billingModel === "subscription" || pricing.pricing_source === "subscription_cli";
  if (isSubscription && tokenCost <= 0) {
    tokenCost =
      (inputTokens / 1_000_000) * 1 +
      (outputTokens / 1_000_000) * 3;
  }
  const baseCost = tokenCost;

  const successRate = Math.max(health.success_rate_24h ?? health.success_rate_7d ?? 0.75, 0.05);
  const healthConfidence = health.health_confidence ?? 1;
  const reliabilityPenalty = (1 - healthConfidence) * baseCost * 0.5;
  const retryCost = baseCost * (1 / successRate - 1) * 0.5;
  const fallbackCost = baseCost * (health.provider_error_rate ?? 0) * 0.25;
  const latencyPenalty = model.local
    ? ((health.avg_latency_ms ?? 2000) / 1_000_000) * 0.01
    : ((health.avg_latency_ms ?? 2000) / 10_000) * Math.max(baseCost, 0.000001);
  const quotaRisk =
    billingModel === "subscription" ? baseCost * (1 - successRate) * 0.15 : 0;

  const operationalCost = model.local ? latencyPenalty * 2 : 0;
  const effective =
    (baseCost + retryCost + fallbackCost + latencyPenalty + operationalCost + reliabilityPenalty + quotaRisk) /
    successRate;

  return {
    base_cost: round(tokenCost),
    effective_cost: round(Math.max(effective, model.local ? 1e-7 : baseCost * 0.01, 1e-9)),
    success_rate: successRate,
    billing_model: billingModel
  };
}

export function scoreModelForTask(model, taskType, options = {}) {
  const floor = resolveTaskFloor(taskType, options);
  const quality = taskQualityScore(model.benchmarks, taskType);
  const measuredReliability = model.health?.success_rate_24h ?? model.health?.success_rate_7d ?? 0.75;
  const healthMeta = resolveHealthMeta(model.health);
  const reliability = effectiveReliability(model.health ?? { success_rate_24h: measuredReliability });
  const healthConfidence = healthMeta.confidence;
  const benchmarkConfidence = model.benchmarks?.benchmark_confidence ?? 0.5;
  const capability = capabilityMatchScore(model, taskType, options);
  const cost = computeEffectiveCost(model, options);
  const priceConf = pricingConfidence(model);

  const passesFloor = passesTaskFloor(model, taskType, quality, reliability, options);
  if (!passesFloor.pass) {
    return {
      ...passesFloor,
      score: 0,
      effective_cost: cost.effective_cost,
      reliability: round(reliability),
      measured_reliability: round(measuredReliability),
      health_confidence: healthConfidence,
      task_quality: round(quality),
      pricing_confidence: priceConf,
      is_premium: isPremiumModel(model)
    };
  }

  const taskQuality = usesSweBenchForTask(taskType)
    ? quality
    : taskQualityScore(model.benchmarks, taskType);

  const strategy = resolveSelectionStrategy(taskType, options);
  let score;
  if (strategy === "min_cost_above_floor") {
    // Lower cost → higher score for sort compatibility; primary sort uses cost directly.
    score = 1 / Math.max(cost.effective_cost, 1e-9);
  } else if (strategy === "max_quality_with_cost_awareness") {
    score =
      (taskQuality * reliability * capability * benchmarkConfidence) /
      Math.max(Math.sqrt(cost.effective_cost), 1e-9);
  } else {
    const numerator = taskQuality * reliability * capability * benchmarkConfidence;
    score = numerator / Math.max(cost.effective_cost, 1e-9);
  }

  return {
    pass: true,
    score: round(score),
    task_quality: round(taskQuality),
    reliability: round(reliability),
    measured_reliability: round(measuredReliability),
    health_confidence: healthConfidence,
    capability_match: round(capability),
    benchmark_confidence: benchmarkConfidence,
    pricing_confidence: priceConf,
    effective_cost: cost.effective_cost,
    base_cost: cost.base_cost,
    is_premium: isPremiumModel(model),
    avg_latency_ms: model.health?.avg_latency_ms ?? null,
    reason: null
  };
}

export function resolveSelectionStrategy(taskType, options = {}) {
  if (options.strategy) return options.strategy;
  const cheap = options.cheapTaskConfig;
  if (cheap && isCostFloorTask(taskType, { ...options, cheapTaskConfig: cheap })) {
    return cheap.strategy ?? "min_cost_above_floor";
  }
  if (!cheap && isCostFloorTask(taskType, options)) {
    return "min_cost_above_floor";
  }
  return "quality_over_cost";
}

export function resolveTaskFloor(taskType, options = {}) {
  const floor = { ...(TASK_FLOORS[taskType] ?? TASK_FLOORS.chat) };
  const delta = options.cheapTaskConfig?.allowLowerQualityFloorDelta ?? 0;
  if (delta > 0) {
    floor.min_quality = Math.max(0, floor.min_quality - delta);
  }
  // High-complexity chat is not a cheap-task path — raise floors toward mid/code quality.
  if (taskType === "chat" && (options.complexity ?? 1) >= 4) {
    floor.min_quality = Math.max(floor.min_quality, 0.55);
    floor.min_reliability = Math.max(floor.min_reliability, 0.92);
  }
  return floor;
}

export function rankModelsForTask(models, taskType, options = {}) {
  const cheapTaskConfig =
    options.cheapTaskConfig ??
    (options.smartRoute
      ? getCheapTaskOptimization(options.smartRoute, options.mode)
      : getCheapTaskOptimization({}, options.mode ?? "balanced"));

  const rankOptions = {
    ...options,
    cheapTaskConfig,
    minPricingConfidence:
      options.minPricingConfidence ?? cheapTaskConfig.minPricingConfidence ?? 0
  };

  const strategy = resolveSelectionStrategy(taskType, rankOptions);
  const scored = models.map((model) => ({
    model,
    ranking: scoreModelForTask(model, taskType, rankOptions)
  }));

  const passers = scored.filter((row) => row.ranking.pass);
  const explanation = {
    selection_strategy: strategy,
    quality_floor: resolveTaskFloor(taskType, rankOptions).min_quality,
    reliability_floor: resolveTaskFloor(taskType, rankOptions).min_reliability,
    premium_blocked: false,
    premium_block_reason: null,
    winner_reason: null
  };

  let eligible = passers;
  if (
    strategy === "min_cost_above_floor" &&
    cheapTaskConfig.premiumAllowedOnlyIfNoCheaperPasses !== false
  ) {
    const nonPremium = passers.filter((row) => !row.ranking.is_premium);
    const premiumPassers = passers.filter((row) => row.ranking.is_premium);
    if (nonPremium.length && premiumPassers.length) {
      eligible = nonPremium;
      explanation.premium_blocked = true;
      explanation.premium_block_reason = "cheaper_model_passed_floor";
    }
  }

  const sorted = [...eligible].sort((a, b) => compareCandidates(a, b, strategy));

  if (sorted[0]) {
    explanation.winner_reason =
      strategy === "min_cost_above_floor"
        ? "lowest_effective_cost_above_floor"
        : strategy === "max_quality_with_cost_awareness"
          ? "highest_quality_with_cost_awareness"
          : "highest_quality_cost_ratio";
    explanation.winner_quality = sorted[0].ranking.task_quality;
    explanation.winner_effective_cost = sorted[0].ranking.effective_cost;
  }

  // Attach explanation on first row for callers that need it
  if (sorted[0]) {
    sorted[0].explanation = explanation;
  }

  return sorted;
}

function compareCandidates(a, b, strategy) {
  if (strategy === "min_cost_above_floor") {
    if (a.ranking.effective_cost !== b.ranking.effective_cost) {
      return a.ranking.effective_cost - b.ranking.effective_cost;
    }
    if (a.ranking.reliability !== b.ranking.reliability) {
      return b.ranking.reliability - a.ranking.reliability;
    }
    const latA = a.ranking.avg_latency_ms ?? 1e9;
    const latB = b.ranking.avg_latency_ms ?? 1e9;
    if (latA !== latB) return latA - latB;
    if (a.ranking.task_quality !== b.ranking.task_quality) {
      return b.ranking.task_quality - a.ranking.task_quality;
    }
    return (b.ranking.pricing_confidence ?? 0) - (a.ranking.pricing_confidence ?? 0);
  }

  if (strategy === "max_quality_with_cost_awareness") {
    if (a.ranking.task_quality !== b.ranking.task_quality) {
      return b.ranking.task_quality - a.ranking.task_quality;
    }
    return a.ranking.effective_cost - b.ranking.effective_cost;
  }

  return b.ranking.score - a.ranking.score;
}

export function rankAllTasks(models, taskTypes = Object.keys(TASK_FLOORS), options = {}) {
  const rankings = {};
  const mode = options.mode ?? "balanced";
  const smartRoute = options.smartRoute ?? { mode };
  for (const taskType of taskTypes) {
    const ranked = rankModelsForTask(models, taskType, { ...options, mode, smartRoute });
    const explanation = ranked[0]?.explanation ?? null;
    rankings[taskType] = ranked.slice(0, 10).map((row, index) => ({
      rank: index + 1,
      canonical_id: row.model.canonical_id,
      provider: row.model.provider,
      model: row.model.model,
      score: row.ranking.score,
      effective_cost: row.ranking.effective_cost,
      task_quality: row.ranking.task_quality,
      reliability: row.ranking.reliability,
      selection_strategy: index === 0 ? explanation?.selection_strategy ?? null : null,
      winner_reason: index === 0 ? explanation?.winner_reason ?? null : null,
      premium_blocked: index === 0 ? explanation?.premium_blocked ?? null : null
    }));
  }
  return rankings;
}

/**
 * Full ranking explanation for diagnostics / explain-ranking CLI.
 */
export function explainRanking(models, taskType, options = {}) {
  const cheapTaskConfig =
    options.cheapTaskConfig ??
    getCheapTaskOptimization(options.smartRoute ?? {}, options.mode ?? "balanced");
  const rankOptions = {
    ...options,
    cheapTaskConfig,
    minPricingConfidence: cheapTaskConfig.minPricingConfidence ?? 0.7
  };
  const floor = resolveTaskFloor(taskType, rankOptions);
  const strategy = resolveSelectionStrategy(taskType, rankOptions);

  const evaluated = models.map((model) => {
    const ranking = scoreModelForTask(model, taskType, rankOptions);
    return {
      canonical_id: model.canonical_id,
      provider: model.provider,
      model: model.model,
      pass: ranking.pass,
      excluded_reason: ranking.pass ? null : ranking.reason,
      effective_cost: ranking.effective_cost,
      task_quality: ranking.task_quality ?? taskQualityScore(model.benchmarks, taskType),
      reliability: ranking.reliability,
      pricing_confidence: ranking.pricing_confidence ?? pricingConfidence(model),
      is_premium: isPremiumModel(model),
      avg_latency_ms: model.health?.avg_latency_ms ?? null,
      pricing_evidence: {
        pricing_status: model.pricing?.pricing_status ?? null,
        pricing_source: model.pricing?.pricing_source ?? null,
        source_url: model.pricing?.source_url ?? null,
        cost_sensitive_eligible: model.pricing?.cost_sensitive_eligible ?? null,
        input_per_1m: model.pricing?.input_per_1m ?? null,
        output_per_1m: model.pricing?.output_per_1m ?? null
      }
    };
  });

  const passers = evaluated.filter((row) => row.pass);
  const excluded = evaluated.filter((row) => !row.pass);

  let eligible = passers;
  let premium_blocked = false;
  let premium_block_reason = null;
  const runner_ups = [];

  if (
    strategy === "min_cost_above_floor" &&
    cheapTaskConfig.premiumAllowedOnlyIfNoCheaperPasses !== false
  ) {
    const nonPremium = passers.filter((row) => !row.is_premium);
    const premiumPassers = passers.filter((row) => row.is_premium);
    if (nonPremium.length && premiumPassers.length) {
      eligible = nonPremium;
      premium_blocked = true;
      premium_block_reason = "cheaper_model_passed_floor";
      for (const row of premiumPassers) {
        runner_ups.push({
          ...row,
          excluded_reason: "premium_not_needed_for_safe_cheap_task"
        });
      }
    }
  }

  eligible.sort((a, b) => {
    if (strategy === "min_cost_above_floor") {
      if (a.effective_cost !== b.effective_cost) return a.effective_cost - b.effective_cost;
      if (a.reliability !== b.reliability) return b.reliability - a.reliability;
      const latA = a.avg_latency_ms ?? 1e9;
      const latB = b.avg_latency_ms ?? 1e9;
      if (latA !== latB) return latA - latB;
      if (a.task_quality !== b.task_quality) return b.task_quality - a.task_quality;
      return (b.pricing_confidence ?? 0) - (a.pricing_confidence ?? 0);
    }
    return b.task_quality - a.task_quality || a.effective_cost - b.effective_cost;
  });

  const winner = eligible[0] ?? null;

  return {
    task_type: taskType,
    mode: options.mode ?? "balanced",
    selection_strategy: strategy,
    winner_reason: winner
      ? strategy === "min_cost_above_floor"
        ? "lowest_effective_cost_above_floor"
        : "highest_quality_with_cost_awareness"
      : "no_model_passed_floor",
    quality_floor: floor.min_quality,
    reliability_floor: floor.min_reliability,
    min_pricing_confidence: rankOptions.minPricingConfidence,
    winner_quality: winner?.task_quality ?? null,
    winner_effective_cost: winner?.effective_cost ?? null,
    winner_canonical_id: winner?.canonical_id ?? null,
    premium_blocked,
    premium_block_reason,
    passed_floor: eligible,
    excluded,
    runner_ups,
    cheap_task_config: cheapTaskConfig
  };
}

export function passesTaskFloor(model, taskType, quality, reliability, options = {}) {
  const floor = resolveTaskFloor(taskType, options);
  const healthMeta = resolveHealthMeta(model.health);
  const healthSource = healthMeta.source;
  const healthConfidence = healthMeta.confidence;

  if (model.available === false) {
    return { pass: false, reason: "model_unavailable" };
  }
  if (model.health_excluded || shouldExcludeHealth(model.health, model)) {
    return { pass: false, reason: "health_excluded" };
  }
  if (healthSource === "unknown" || healthConfidence <= 0) {
    return { pass: false, reason: "unknown_health" };
  }
  if (requiresDirectHealth(taskType)) {
    const okSource =
      healthSource === "direct_probe" ||
      (healthSource === "prior_snapshot" && healthConfidence >= 0.7);
    if (!okSource) {
      return { pass: false, reason: "health_confidence_too_low" };
    }
  }
  if (reliability < floor.min_reliability) {
    return {
      pass: false,
      reason:
        healthConfidence < 1 && healthSource !== "direct_probe"
          ? "below_min_reliability_health_confidence"
          : "below_min_reliability"
    };
  }
  if (quality < floor.min_quality) {
    return { pass: false, reason: "below_min_quality" };
  }
  if (
    options.costSensitive !== false &&
    pricingBlocksCostSensitiveRoute(model.pricing, options.pricingOverrides)
  ) {
    return { pass: false, reason: "unknown_pricing" };
  }
  const minPriceConf = options.minPricingConfidence ?? 0;
  if (minPriceConf > 0 && pricingConfidence(model) < minPriceConf) {
    return { pass: false, reason: "below_min_pricing_confidence" };
  }
  if (floor.requires_json_probe && model.health?.last_probe_status === "fail") {
    return { pass: false, reason: "json_probe_failed" };
  }
  if (options.config?.providers) {
    const providerConfig = options.config.providers[model.provider];
    if (!providerConfig || providerConfig.enabled === false) {
      return { pass: false, reason: "executor_unavailable" };
    }
  }
  return { pass: true, reason: null };
}

function capabilityMatchScore(model, taskType, options) {
  const caps = model.capabilities ?? {};
  let score = 0.7;
  if (options.requiresTools && !caps.tool_calling) score -= 0.4;
  if (options.requiresVision && !caps.vision) score -= 0.4;
  if (options.requiresStrictJson && !(caps.json_mode || caps.structured_output)) score -= 0.3;
  if (["code", "code_debug", "architecture"].includes(taskType) && caps.coding === "high") score += 0.15;
  if (model.routing?.prefer_for?.includes(taskType)) score += 0.1;
  return Math.min(1, Math.max(0.1, score));
}

function round(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function pickBestModelForTask(models, taskType, options = {}) {
  const ranked = rankModelsForTask(models, taskType, options);
  return ranked[0]?.model ?? null;
}

export const CHEAP_TASK_TRIAL_TYPES = ["chat", "rewrite", "summarize", "extract", "extract_json"];

export function checkCheapTaskTrialReadiness(rankings, taskTypes = CHEAP_TASK_TRIAL_TYPES) {
  const missing = [];
  const winners = {};

  for (const taskType of taskTypes) {
    const key = taskType === "extract" ? "extract_json" : taskType;
    const rows = rankings[key] ?? rankings[taskType] ?? [];
    if (!rows.length) {
      missing.push(taskType);
      continue;
    }
    winners[taskType] = rows[0];
  }

  return {
    ready: missing.length === 0,
    missing,
    winners,
    antigravity_ranked: Object.values(winners).some((row) => row?.provider === "antigravity")
  };
}

export function pricingStatus(pricing) {
  if (!pricing) {
    return "missing";
  }
  if (pricing.pricing_source === "unknown" || pricing.input_per_1m == null) {
    return "unknown";
  }
  return "known";
}

export function classifyExclusionIssue(reason, model, quality, reliability, floor) {
  switch (reason) {
    case "health_excluded":
    case "model_unavailable":
    case "json_probe_failed":
    case "unknown_health":
    case "health_confidence_too_low":
    case "below_min_reliability_health_confidence":
      return "provider_health";
    case "unknown_pricing":
      return "pricing";
    case "below_min_quality":
      return model.benchmarks?.benchmark_confidence != null && model.benchmarks.benchmark_confidence < 0.5
        ? "benchmark"
        : "floor_threshold";
    case "below_min_reliability":
      return model.health?.last_checked ? "provider_health" : "floor_threshold";
    default:
      return "floor_threshold";
  }
}

function normalizeTaskKey(taskType) {
  return taskType === "extract" ? "extract_json" : taskType;
}

function analyzeModelRow(model, taskType, options = {}) {
  const key = normalizeTaskKey(taskType);
  const floor = TASK_FLOORS[key] ?? TASK_FLOORS.chat;
  const quality = taskQualityScore(model.benchmarks, taskType);
  const reliability = effectiveReliability(model.health ?? {});
  const floorCheck = passesTaskFloor(model, taskType, quality, reliability, options);
  const cost = computeEffectiveCost(model, options);

  return {
    canonical_id: model.canonical_id,
    provider: model.provider,
    model: model.model,
    pass: floorCheck.pass,
    exclusion_reason: floorCheck.pass ? null : floorCheck.reason,
    reliability: round(reliability),
    measured_reliability: round(model.health?.success_rate_24h ?? model.health?.success_rate_7d ?? 0.75),
    health_confidence: model.health?.health_confidence ?? 0,
    health_source: model.health?.health_source ?? "unknown",
    quality: round(quality),
    effective_cost: cost.effective_cost,
    health_failure_category: model.health?.last_failure_category ?? null,
    health_probe_status: model.health?.last_probe_status ?? null,
    pricing_status: pricingStatus(model.pricing),
    benchmark_confidence: model.benchmarks?.benchmark_confidence ?? null,
    benchmark_last_checked: model.benchmarks?.benchmark_last_checked ?? null,
    issue_category: floorCheck.pass
      ? null
      : classifyExclusionIssue(floorCheck.reason, model, quality, reliability, floor)
  };
}

function closestExcludedScore(row, floor) {
  const relGap = Math.max(0, floor.min_reliability - row.reliability);
  const qualGap = Math.max(0, floor.min_quality - row.quality);
  return relGap * 2 + qualGap + (row.exclusion_reason === "health_excluded" ? 1 : 0);
}

export function buildPreflightDiagnostics(models, taskTypes = CHEAP_TASK_TRIAL_TYPES, options = {}) {
  const snapshotAt = options.snapshotGeneratedAt ?? null;
  const missingPricing = [];
  const failedHealthProbes = [];

  for (const model of models) {
    if (pricingStatus(model.pricing) !== "known") {
      missingPricing.push({
        canonical_id: model.canonical_id,
        provider: model.provider,
        pricing_source: model.pricing?.pricing_source ?? "missing"
      });
    }
    if (model.health?.last_probe_status === "fail" || model.health?.response_ok === false) {
      failedHealthProbes.push({
        canonical_id: model.canonical_id,
        provider: model.provider,
        failure_category: model.health?.last_failure_category ?? "probe_fail",
        last_probe_status: model.health?.last_probe_status ?? null
      });
    }
  }

  const perTask = [];

  for (const taskType of taskTypes) {
    const key = normalizeTaskKey(taskType);
    const floor = TASK_FLOORS[key] ?? TASK_FLOORS.chat;
    const rows = models.map((model) => analyzeModelRow(model, taskType, options));
    const passing = rows.filter((row) => row.pass);
    const excluded = rows.filter((row) => !row.pass);

    passing.sort((a, b) => {
      const scoreA = (a.quality * a.reliability) / Math.max(a.effective_cost, 1e-9);
      const scoreB = (b.quality * b.reliability) / Math.max(b.effective_cost, 1e-9);
      return scoreB - scoreA;
    });

    excluded.sort((a, b) => closestExcludedScore(a, floor) - closestExcludedScore(b, floor));

    const bestCandidate = passing[0] ?? excluded[0] ?? null;
    const bestExcluded = passing.length ? null : (excluded[0] ?? null);

    const staleBenchmarks = excluded
      .filter((row) => row.benchmark_confidence != null && row.benchmark_confidence < 0.5)
      .slice(0, 5)
      .map((row) => ({
        canonical_id: row.canonical_id,
        benchmark_confidence: row.benchmark_confidence,
        benchmark_last_checked: row.benchmark_last_checked
      }));

    perTask.push({
      task_type: taskType,
      required_floor: { ...floor },
      passes: passing.length > 0,
      winner: passing[0] ?? null,
      best_candidate: bestCandidate,
      why_best_failed: bestCandidate && !bestCandidate.pass
        ? {
            exclusion_reason: bestCandidate.exclusion_reason,
            issue_category: bestCandidate.issue_category,
            reliability: bestCandidate.reliability,
            quality: bestCandidate.quality,
            required: floor
          }
        : passing.length
          ? null
          : { message: "no candidates in snapshot" },
      top_excluded: excluded.slice(0, 3),
      stale_benchmark_eval: staleBenchmarks,
      issue_summary: summarizeTaskIssues(excluded, floor)
    });
  }

  return {
    per_task: perTask,
    missing_pricing: missingPricing.slice(0, 20),
    missing_pricing_count: missingPricing.length,
    failed_health_probes: failedHealthProbes.slice(0, 20),
    failed_health_probe_count: failedHealthProbes.length,
    snapshot_generated_at: snapshotAt,
    antigravity_in_snapshot: models.some((m) => m.provider === "antigravity"),
    antigravity_health_excluded: models.some(
      (m) => m.provider === "antigravity" && (m.health_excluded || m.available === false)
    )
  };
}

function summarizeTaskIssues(excluded, floor) {
  const counts = {};
  for (const row of excluded) {
    const cat = row.issue_category ?? "floor_threshold";
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return {
    dominant_issue: dominant?.[0] ?? null,
    by_category: counts,
    below_reliability_floor: excluded.filter((r) => r.exclusion_reason === "below_min_reliability").length,
    below_quality_floor: excluded.filter((r) => r.exclusion_reason === "below_min_quality").length,
    health_excluded: excluded.filter((r) => r.exclusion_reason === "health_excluded").length,
    unknown_pricing: excluded.filter((r) => r.exclusion_reason === "unknown_pricing").length
  };
}
