/**
 * Routing priority (PARAGON-D-004E, Phase 5).
 *
 * Replaces the seven `routing.taskRoutes` provider preferences — and the
 * scattered numeric routing knobs — with one control an ordinary user can
 * reason about. The four presets are the *only* routing preference in the
 * product; everything else about a decision is evidence, not configuration.
 *
 * Each preset is a transparent set of multipliers over the expected-utility
 * weights. Nothing here is a hidden mode switch and nothing here can bypass a
 * hard gate: capability, context, health, circuit, quota and catalog
 * eligibility are decided before any of these numbers are consulted, so a
 * preset can only reorder admissible candidates, never admit an inadmissible
 * one.
 */

import { UTILITY_WEIGHTS } from "./expectedUtility.js";

export const ROUTING_PRIORITIES = ["balanced", "quality", "cost", "speed"];

export const DEFAULT_ROUTING_PRIORITY = "balanced";

/**
 * Product-facing copy. The dashboard renders these; it never renders the raw
 * multipliers (those are Diagnostics-only, read-only).
 */
export const ROUTING_PRIORITY_LABELS = {
  balanced: {
    label: "Balanced",
    summary: "Weighs quality, cost, speed and confidence evenly."
  },
  quality: {
    label: "Best quality",
    summary: "Favors the most capable model, and higher reasoning where it is justified."
  },
  cost: {
    label: "Lower cost",
    summary: "Favors cheaper models while accounting for published token costs."
  },
  speed: {
    label: "Faster",
    summary: "Favors models that respond quickly."
  }
};

/**
 * Multipliers applied to UTILITY_WEIGHTS. A value of 1 means "unchanged from
 * balanced". Documented per preset so the behavior claimed in the UI is the
 * behavior in the code.
 */
const PRIORITY_MULTIPLIERS = {
  balanced: {
    qualityScale: 1,
    resourceCostScale: 1,
    latencyPenaltyScale: 1,
    quotaScarcityScale: 1,
    uncertaintyScale: 1,
    reasoningFitScale: 1
  },
  quality: {
    // Quality and success probability dominate; cost and latency matter less.
    // reasoningFitScale drops so that *justified* higher reasoning is not
    // penalized as hard for exceeding a modest demand estimate — this is the
    // only preset that may select a higher reasoning effort.
    qualityScale: 1.5,
    resourceCostScale: 0.5,
    latencyPenaltyScale: 0.6,
    quotaScarcityScale: 0.8,
    uncertaintyScale: 1.2,
    reasoningFitScale: 0.6
  },
  cost: {
    // Monetary cost and quota burn dominate. Quality is *not* zeroed — a
    // cheap model that cannot do the job still loses on the quality term, and
    // capability minimums remain hard gates regardless of this preset.
    qualityScale: 0.9,
    resourceCostScale: 2.2,
    latencyPenaltyScale: 0.8,
    quotaScarcityScale: 2.5,
    uncertaintyScale: 1,
    reasoningFitScale: 1.4
  },
  speed: {
    // Latency dominates. Quality stays close to baseline so "faster" cannot
    // select an incapable model merely because it is quick.
    qualityScale: 0.95,
    resourceCostScale: 1,
    latencyPenaltyScale: 3,
    quotaScarcityScale: 1,
    uncertaintyScale: 1,
    reasoningFitScale: 1.6
  }
};

export function normalizeRoutingPriority(value) {
  const candidate = String(value ?? "").trim().toLowerCase();
  return ROUTING_PRIORITIES.includes(candidate) ? candidate : DEFAULT_ROUTING_PRIORITY;
}

/**
 * Resolves a preset to concrete utility weights.
 *
 * Provider preference is an explicit scoring term, not a routing-priority
 * multiplier. The configured scale is passed alongside these evidence
 * weights so the dashboard and scorer use one calculation.
 */
export function resolveUtilityWeights(priority) {
  const preset = normalizeRoutingPriority(priority);
  const multipliers = PRIORITY_MULTIPLIERS[preset];
  const weights = { providerPreferenceScale: UTILITY_WEIGHTS.providerPreferenceScale };
  for (const [key, multiplier] of Object.entries(multipliers)) {
    weights[key] = UTILITY_WEIGHTS[key] * multiplier;
  }
  return weights;
}

/** Read-only description for Diagnostics: preset, multipliers and resolved weights. */
export function routingPriorityDescription(priority) {
  const preset = normalizeRoutingPriority(priority);
  return {
    priority: preset,
    ...ROUTING_PRIORITY_LABELS[preset],
    multipliers: PRIORITY_MULTIPLIERS[preset],
    resolvedWeights: resolveUtilityWeights(preset),
    baselineWeights: UTILITY_WEIGHTS
  };
}

/** Every preset, for rendering the picker without hardcoding copy in the UI. */
export function routingPriorityOptions() {
  return ROUTING_PRIORITIES.map((priority) => ({ value: priority, ...ROUTING_PRIORITY_LABELS[priority] }));
}
