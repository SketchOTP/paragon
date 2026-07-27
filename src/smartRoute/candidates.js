import { TIER_RANK } from "./constants.js";

export function filterCandidates(registry, features, settings, decision = null) {
  let candidates = [...registry];

  if (features.hasImage) {
    candidates = candidates.filter((entry) => entry.capabilities?.vision);
  }

  if (features.requiresTools) {
    candidates = candidates.filter((entry) => entry.capabilities?.tool_calling);
  }

  if (features.requiresStrictJson) {
    candidates = candidates.filter(
      (entry) => entry.capabilities?.json_mode || entry.capabilities?.structured_output
    );
  }

  if (features.estimatedTokens) {
    candidates = candidates.filter(
      (entry) => (entry.capabilities?.context_tokens ?? 0) >= features.estimatedTokens
    );
  }

  if (settings?.localPrivateFirst || decision?.privacy_level === "local_only") {
    const local = candidates.filter((entry) => entry.local);
    if (local.length) {
      candidates = local;
    }
  }

  if (decision) {
    candidates = filterByClassifierDecision(candidates, decision);
  }

  return candidates;
}

export function filterByClassifierDecision(candidates, decision) {
  const original = candidates;
  let filtered = candidates;

  if (decision?.recommended_tier) {
    const minTier = TIER_RANK[decision.recommended_tier] ?? 0;
    const tierFiltered = filtered.filter((entry) => (TIER_RANK[entry.tier] ?? 0) >= minTier);
    if (tierFiltered.length) {
      filtered = tierFiltered;
    }
  }

  if (decision?.task_type && decision.task_type !== "unknown") {
    const preferred = filtered.filter((entry) =>
      entry.routing?.prefer_for?.includes(decision.task_type)
    );
    if (preferred.length) {
      filtered = preferred;
    }

    const avoided = filtered.filter(
      (entry) => !entry.routing?.avoid_for?.includes(decision.task_type)
    );
    if (avoided.length) {
      filtered = avoided;
    }
  }

  if ((decision?.complexity ?? 0) >= 4) {
    const strong = filtered.filter(
      (entry) =>
        entry.capabilities?.reasoning === "high" || entry.tier === "premium" || entry.tier === "mid"
    );
    if (strong.length) {
      filtered = strong;
    }
  }

  return filtered.length ? filtered : original;
}
