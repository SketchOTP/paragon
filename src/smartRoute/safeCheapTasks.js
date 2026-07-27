import { TIER_RANK } from "./constants.js";
import { buildProviderAttempts } from "../providerFallback.js";
import { computeEffectiveCost } from "./modelRanker.js";
import { isActiveSmartRouteMode } from "./modelSnapshotStore.js";
import {
  buildIntelligenceAttempts,
  mergeExecutionConfig
} from "./executionPolicy.js";

export const DEFAULT_SAFE_CHEAP_TASKS = {
  taskTypes: ["chat", "rewrite", "summarize", "extract", "extract_json", "math"],
  maxComplexity: 2,
  maxRisk: 2,
  maxTier: "cheap",
  maxCostPer1m: null,
  maxEffectiveCost: null,
  minReliability: null,
  fallbackWithinTierFirst: true,
  fallbackToLegacyBeforePremium: true,
  requireExplicitReasonForPremiumFallback: true
};

export function mergeSafeCheapTasks(settings = {}) {
  const balanced = settings.balanced ?? {};
  return {
    ...DEFAULT_SAFE_CHEAP_TASKS,
    ...(balanced.safeCheapTasks ?? settings.safeCheapTasks ?? {})
  };
}

export function isSafeCheapTask(decision, safeCheap = DEFAULT_SAFE_CHEAP_TASKS) {
  const taskType = decision?.task_type ?? "unknown";
  const complexity = decision?.complexity ?? 99;
  const risk = decision?.risk ?? 99;
  return (
    safeCheap.taskTypes?.includes(taskType) &&
    complexity <= (safeCheap.maxComplexity ?? 2) &&
    risk <= (safeCheap.maxRisk ?? 2)
  );
}

/** Filter-only: never picks a provider by name. */
export function passesSafeCheapFilters(entry, decision, config, options = {}) {
  const safeCheap = mergeSafeCheapTasks(config?.routing?.smartRoute ?? {});
  if (!isSafeCheapTask(decision, safeCheap) || !entry) {
    return { passes: true, reason: null };
  }

  if (requiresPremiumCapability({ classifier: decision, features: options.features })) {
    return { passes: true, reason: null };
  }

  const maxRank = tierRank(safeCheap.maxTier ?? "cheap");
  if (tierRank(entry.tier) > maxRank) {
    return { passes: false, reason: `tier_above_ceiling:${entry.tier}` };
  }

  const inputCost = (entry.cost_input_per_1m ?? 0) + (entry.cost_output_per_1m ?? 0);
  if (safeCheap.maxCostPer1m != null && inputCost > safeCheap.maxCostPer1m) {
    return { passes: false, reason: "max_cost_exceeded" };
  }

  if (safeCheap.maxEffectiveCost != null) {
    const effective = computeEffectiveCost(
      {
        pricing: {
          input_per_1m: entry.cost_input_per_1m,
          output_per_1m: entry.cost_output_per_1m
        },
        health: { success_rate_24h: entry.reliability },
        local: entry.local
      },
      {}
    );
    if (effective.effective_cost > safeCheap.maxEffectiveCost) {
      return { passes: false, reason: "max_effective_cost_exceeded" };
    }
  }

  const minRel = safeCheap.minReliability ?? 0;
  const reliability = entry.reliability ?? entry.intelligence?.reliability ?? 0;
  if (minRel > 0 && reliability < minRel) {
    return { passes: false, reason: "below_min_reliability" };
  }

  const features = options.features ?? {};
  if (features.requires_tools && !entry.capabilities?.tool_calling) {
    return { passes: false, reason: "missing_tool_calling" };
  }
  if (features.has_image && !entry.capabilities?.vision) {
    return { passes: false, reason: "missing_vision" };
  }
  if (
    features.requires_strict_json &&
    !(entry.capabilities?.json_mode || entry.capabilities?.structured_output)
  ) {
    return { passes: false, reason: "missing_json_mode" };
  }

  if (options.liveProviderHealth?.[entry.provider]?.healthy === false) {
    return { passes: false, reason: "provider_unhealthy" };
  }

  return { passes: true, reason: null };
}

/** @deprecated Use passesSafeCheapFilters — kept for legacy/shadow paths without intelligence override. */
export function selectSafeCheapProvider(selected, candidates, decision, config, options = {}) {
  const check = passesSafeCheapFilters(selected, decision, config, options);
  if (!check.passes && candidates?.length) {
    const safeCheap = mergeSafeCheapTasks(config?.routing?.smartRoute ?? {});
    const maxRank = tierRank(safeCheap.maxTier ?? "cheap");
    const withinTier = candidates.filter((entry) => tierRank(entry.tier) <= maxRank);
    const passing = withinTier.filter(
      (entry) => passesSafeCheapFilters(entry, decision, config, options).passes
    );
    const fallback = pickBestWithinTier(passing);
    if (fallback && fallback.id !== selected?.id) {
      return { selected: fallback, reason: `safe_cheap_filter:${check.reason}` };
    }
  }
  return { selected, reason: check.passes ? null : check.reason };
}

export function applyCheapTaskTierCeiling(selected, candidates, decision, config) {
  const mode = config?.routing?.smartRoute?.mode ?? "shadow_test";
  if (isActiveSmartRouteMode(mode)) {
    return selected;
  }

  const safeCheap = mergeSafeCheapTasks(config?.routing?.smartRoute ?? {});
  if (!isSafeCheapTask(decision, safeCheap) || !selected || !candidates?.length) {
    return selected;
  }

  const maxRank = tierRank(safeCheap.maxTier ?? "cheap");
  if (tierRank(selected.tier) <= maxRank) {
    return selected;
  }

  const withinCeiling = candidates.filter((entry) => tierRank(entry.tier) <= maxRank);
  if (!withinCeiling.length) {
    return selected;
  }

  return pickBestWithinTier(withinCeiling);
}

function pickBestWithinTier(entries) {
  return [...entries].sort(
    (a, b) =>
      tierRank(b.tier) - tierRank(a.tier) || (b.routing?.priority ?? 0) - (a.routing?.priority ?? 0)
  )[0];
}

function tierRank(tier) {
  return TIER_RANK[tier] ?? -1;
}

export function requiresPremiumCapability(smartDecision) {
  const features = smartDecision?.features ?? {};
  const classifier = smartDecision?.classifier ?? {};
  return Boolean(
    features.requires_tools ||
      features.has_image ||
      features.requires_strict_json ||
      classifier.needs_tools ||
      classifier.needs_vision ||
      classifier.needs_strict_json ||
      classifier.needs_long_context
  );
}

export function buildSmartRouteAttempts({
  config,
  registry,
  primary,
  legacyProvider,
  smartDecision,
  liveProviderHealth = null,
  intelligenceActive = false
}) {
  const safeCheap = mergeSafeCheapTasks(config?.routing?.smartRoute ?? {});
  const decision = {
    task_type: smartDecision?.task_type,
    complexity: smartDecision?.complexity,
    risk: smartDecision?.risk
  };

  const execution = mergeExecutionConfig(config?.routing?.smartRoute ?? {});
  const timeoutMs = execution.providerTimeoutMs ?? 90_000;

  if (intelligenceActive && smartDecision?.selected_canonical_id) {
    const built = buildIntelligenceAttempts({
      config,
      registry,
      primary,
      legacyProvider,
      smartDecision,
      execution,
      isSafeCheap: isSafeCheapTask(decision, safeCheap),
      maxTier: safeCheap.maxTier ?? "cheap"
    });
    // Attach meta for timeout audit on the attempts array.
    built.attempts.fallback_candidate_count = built.fallback_candidate_count;
    built.attempts.fallback_block_reason = built.fallback_block_reason;
    if (built.attempts.length) {
      return built.attempts;
    }
  }

  if (!isSafeCheapTask(decision, safeCheap)) {
    return applyTimeoutToAttempts(buildProviderAttempts(config, primary), timeoutMs);
  }

  const order = [];
  const seen = new Set();
  const add = (name, modelOverride = null) => {
    if (!name || seen.has(name) || !config.providers[name]?.enabled) {
      return;
    }
    seen.add(name);
    const base = config.providers[name];
    order.push({
      name,
      config: modelOverride != null ? { ...base, model: modelOverride } : base
    });
  };

  const primaryEntry = registry.find((row) => row.provider === primary);
  add(primary, primaryEntry?.model || undefined);

  if (safeCheap.fallbackWithinTierFirst) {
    const cheapProviders = registry
      .filter((entry) => entry.tier === "cheap" && config.providers[entry.provider]?.enabled)
      .sort((a, b) => (b.routing?.priority ?? 0) - (a.routing?.priority ?? 0));
    for (const entry of cheapProviders) {
      add(entry.provider, entry.model || undefined);
    }
  }

  if (safeCheap.fallbackToLegacyBeforePremium) {
    add(legacyProvider);
  }

  const chain = config.routing?.fallbackChain ?? [];
  for (const name of chain) {
    const entry = registry.find((row) => row.provider === name);
    const rank = tierRank(entry?.tier ?? "mid");
    if (rank <= tierRank("mid")) {
      add(name, entry?.model || undefined);
    }
  }

  const allowPremium =
    !safeCheap.requireExplicitReasonForPremiumFallback || requiresPremiumCapability(smartDecision);

  if (allowPremium) {
    for (const name of chain) {
      const entry = registry.find((row) => row.provider === name);
      if (tierRank(entry?.tier ?? "mid") >= tierRank("premium")) {
        add(name, entry?.model || undefined);
      }
    }
  }

  if (!order.length) {
    return applyTimeoutToAttempts(buildProviderAttempts(config, primary), timeoutMs);
  }

  return applyTimeoutToAttempts(order, timeoutMs);
}

function applyTimeoutToAttempts(attempts, timeoutMs) {
  return attempts.map((row) => ({
    ...row,
    config: { ...row.config, timeoutMs: Math.min(row.config?.timeoutMs ?? timeoutMs, timeoutMs) }
  }));
}

export function isPremiumProvider(registry, providerName) {
  const entry = registry.find((row) => row.provider === providerName);
  return tierRank(entry?.tier ?? "mid") >= tierRank("premium");
}
