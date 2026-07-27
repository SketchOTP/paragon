import { REASONING_SCORE, SCORE_WEIGHTS, TIER_RANK } from "./constants.js";
import { estimateCost } from "./registry.js";

const LATENCY_SCORE = { fast: 1, medium: 0.7, slow: 0.4 };
const SIMPLE_LOW_STAKES_TASKS = new Set(["chat", "rewrite", "summarize", "extract"]);

export function scoreAndSelect(candidates, decision, settings) {
  if (!candidates.length) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const mode = normalizeMode(settings?.mode);
  const weights = SCORE_WEIGHTS[mode] ?? SCORE_WEIGHTS.balanced;
  const maxCost = Math.max(...candidates.map(totalCost), 0.01);

  const scored = candidates.map((entry) => ({
    entry,
    score: computeScore(entry, decision, weights, maxCost, settings)
  }));

  scored.sort((a, b) => b.score - a.score || comparePriority(a.entry, b.entry));
  return scored[0].entry;
}

function normalizeMode(mode) {
  if (mode === "shadow_test" || mode === "manual") {
    return "balanced";
  }
  if (mode === "local_private_first") {
    return "local_private_first";
  }
  return mode ?? "balanced";
}

function computeScore(entry, decision, weights, maxCost, settings) {
  const qualityFit = qualityFitScore(entry, decision);
  const capabilityFit = capabilityFitScore(entry, decision);
  const latencyFit = LATENCY_SCORE[entry.latency_class] ?? 0.6;
  const healthScore = settings?.providerHealth?.[entry.provider];
  const reliabilityFit =
    typeof healthScore === "number"
      ? healthScore
      : entry.reliability ?? 0.75;
  const costFit = 1 - totalCost(entry) / maxCost;

  let score =
    qualityFit * (weights.quality_fit ?? 0) +
    capabilityFit * (weights.capability_fit ?? 0) +
    latencyFit * (weights.latency_fit ?? 0) +
    reliabilityFit * (weights.reliability_fit ?? 0) +
    costFit * (weights.cost_fit ?? 0);

  if (settings?.localPrivateFirst && entry.local) {
    score += 0.15;
  }

  if (isSimpleLowStakes(decision)) {
    if (entry.tier === "cheap") {
      score += 0.22;
    }
    if (entry.tier === "mid" || entry.tier === "premium") {
      score -= 0.12;
    }
  }

  return score;
}

function isSimpleLowStakes(decision) {
  if (!decision) {
    return false;
  }
  return (
    SIMPLE_LOW_STAKES_TASKS.has(decision.task_type) &&
    (decision.complexity ?? 3) <= 2 &&
    (decision.risk ?? 3) <= 2
  );
}

function qualityFitScore(entry, decision) {
  if (!decision) {
    return tierQuality(entry.tier);
  }

  const targetTier = TIER_RANK[decision.recommended_tier] ?? 2;
  const entryTier = TIER_RANK[entry.tier] ?? 2;
  const tierDiff = Math.abs(targetTier - entryTier);
  let score = Math.max(0, 1 - tierDiff * 0.25);

  const reasoning = REASONING_SCORE[entry.capabilities?.reasoning] ?? 2;
  const needed = Math.ceil((decision.complexity ?? 3) / 2);
  if (reasoning >= needed) {
    score += 0.15;
  } else {
    score -= 0.2;
  }

  return Math.min(1, Math.max(0, score));
}

function capabilityFitScore(entry, decision) {
  if (!decision) {
    return 0.7;
  }

  let score = 0.6;
  const caps = entry.capabilities ?? {};

  if (decision.needs_vision && caps.vision) score += 0.15;
  if (decision.needs_tools && caps.tool_calling) score += 0.15;
  if (decision.needs_strict_json && (caps.json_mode || caps.structured_output)) score += 0.1;
  if (decision.needs_long_context && (caps.context_tokens ?? 0) >= 100_000) score += 0.1;

  if (decision.task_type && entry.routing?.prefer_for?.includes(decision.task_type)) {
    score += 0.15;
  }
  if (decision.task_type && entry.routing?.avoid_for?.includes(decision.task_type)) {
    score -= 0.3;
  }

  return Math.min(1, Math.max(0, score));
}

function tierQuality(tier) {
  return ({ local: 0.55, cheap: 0.65, mid: 0.8, premium: 0.95 }[tier] ?? 0.7);
}

function totalCost(entry) {
  return (entry.cost_input_per_1m ?? 0) + (entry.cost_output_per_1m ?? 0);
}

function comparePriority(a, b) {
  return (b.routing?.priority ?? 50) - (a.routing?.priority ?? 50);
}

export function estimateRequestCost(entry, inputTokens, outputTokens) {
  return estimateCost(entry, inputTokens, outputTokens);
}
