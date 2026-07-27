import { rankModelsForTask } from "./modelRanker.js";
import { resolveIntelligentSelection } from "./registry.js";
import {
  canUseSnapshotForActiveMode,
  isActiveSmartRouteMode,
  readCurrentSnapshot
} from "./modelSnapshotStore.js";
import { passesSafeCheapFilters } from "./safeCheapTasks.js";

export function usesModelIntelligence(config, snapshot = null) {
  const mode = config?.routing?.smartRoute?.mode ?? "shadow_test";
  if (!isActiveSmartRouteMode(mode)) {
    return { active: false, reason: "passive_mode" };
  }
  const gate = canUseSnapshotForActiveMode(config, snapshot);
  if (!gate.allowed) {
    return { active: false, reason: gate.reason ?? "model_intelligence_stale" };
  }
  return { active: true, reason: null };
}

export function mapEntryToExecutor(entry, config) {
  if (!entry?.provider) {
    return { ok: false, reason: "missing_provider" };
  }
  const providerConfig = config?.providers?.[entry.provider];
  if (!providerConfig?.enabled) {
    return { ok: false, reason: "provider_disabled" };
  }
  return {
    ok: true,
    provider: entry.provider,
    model: entry.model || providerConfig.model || "",
    adapter: providerConfig.type ?? "builtin"
  };
}

export async function selectThroughModelIntelligence({
  taskType,
  features = {},
  config,
  candidates = [],
  safeCheapOptions = {}
}) {
  const snapshot = await readCurrentSnapshot();
  const intelUse = usesModelIntelligence(config, snapshot);
  if (!intelUse.active || !taskType) {
    return {
      used: false,
      reason: intelUse.reason,
      ranking_winner_canonical_id: null,
      selected_canonical_id: null,
      selected: null,
      override_reason: null,
      override_source: null,
      excluded: []
    };
  }

  const mode = config?.routing?.smartRoute?.mode ?? "balanced";
  const rankOptions = {
    requiresTools: features.requires_tools ?? features.requiresTools,
    requiresVision: features.has_image ?? features.hasImage,
    requiresStrictJson: features.requires_strict_json ?? features.requiresStrictJson,
    costSensitive: true,
    complexity: safeCheapOptions.complexity ?? features.complexity ?? 1,
    risk: safeCheapOptions.risk ?? features.risk ?? 1,
    longContext: features.long_context ?? features.longContext ?? false,
    highStakes: taskType === "high_stakes" || (safeCheapOptions.risk ?? 0) >= 4,
    mode,
    smartRoute: config?.routing?.smartRoute ?? { mode },
    config
  };

  const ranked = rankModelsForTask(snapshot.models ?? [], taskType, rankOptions);
  const rankingWinner = ranked[0]?.model ?? null;
  const ranking_winner_canonical_id = rankingWinner?.canonical_id ?? null;
  const ranking_explanation = ranked[0]?.explanation ?? null;
  const excluded = buildExclusionList(snapshot.models ?? [], taskType, rankOptions);

  if (!ranking_winner_canonical_id) {
    return {
      used: true,
      reason: "no_model_passed_quality_floor",
      ranking_winner_canonical_id: null,
      selected_canonical_id: null,
      selected: null,
      override_reason: "no_model_passed_quality_floor",
      override_source: "model_ranker",
      excluded
    };
  }

  const intel = await resolveIntelligentSelection(taskType, config, rankOptions);
  let selected = intel.model;
  let selected_canonical_id = intel.canonical_id ?? ranking_winner_canonical_id;
  let override_reason = null;
  let override_source = null;

  const filterDecision = {
    task_type: taskType,
    complexity: safeCheapOptions.complexity,
    risk: safeCheapOptions.risk
  };
  const filterCheck = passesSafeCheapFilters(selected, filterDecision, config, {
    features: rankOptions,
    liveProviderHealth: safeCheapOptions.liveProviderHealth
  });

  if (!filterCheck.passes) {
    override_reason = filterCheck.reason;
    override_source = "safe_cheap_filter_advisory";
  }

  const executor = mapEntryToExecutor(selected, config);
  if (!executor.ok) {
    return {
      used: true,
      reason: "executor_unavailable",
      ranking_winner_canonical_id,
      selected_canonical_id,
      selected,
      override_reason: executor.reason,
      override_source: "executor_map",
      excluded,
      executor
    };
  }

  return {
    used: true,
    reason: null,
    ranking_winner_canonical_id,
    selected_canonical_id,
    selected,
    override_reason,
    override_source,
    excluded,
    executor,
    ranking_explanation,
    ranked_fallback_ids: ranked
      .slice(1, 8)
      .map((row) => row.model?.canonical_id)
      .filter(Boolean)
  };
}

function buildExclusionList(models, taskType, options) {
  const rankedIds = new Set(rankModelsForTask(models, taskType, options).map((r) => r.model.canonical_id));
  const excluded = [];
  for (const model of models) {
    if (rankedIds.has(model.canonical_id)) {
      continue;
    }
    const scored = rankModelsForTask([model], taskType, options);
    excluded.push({
      canonical_id: model.canonical_id,
      provider: model.provider,
      reason: scored.length ? "passed_but_outranked" : scored[0]?.ranking?.reason ?? "floor_failed"
    });
  }
  return excluded;
}

export function checkExecutionMismatch({
  usesIntelligence,
  ranking_winner_canonical_id,
  final_executed_canonical_id,
  total_fallback_used,
  execution_failed
}) {
  if (!usesIntelligence || !ranking_winner_canonical_id) {
    return { mismatch: false, reason: null };
  }
  if (execution_failed || total_fallback_used) {
    return { mismatch: false, reason: null };
  }
  if (final_executed_canonical_id !== ranking_winner_canonical_id) {
    return {
      mismatch: true,
      reason: `expected ${ranking_winner_canonical_id}, got ${final_executed_canonical_id ?? "null"}`
    };
  }
  return { mismatch: false, reason: null };
}

export function toCanonicalId(provider, model) {
  const modelId = model && String(model).trim() ? String(model).trim() : "default";
  return `${provider}:${modelId}`;
}

export function resolveExecutedCanonicalId(provider, model, registry = []) {
  if (!provider) {
    return null;
  }
  const exact = registry.find((row) => row.provider === provider && (row.model ?? "") === (model ?? ""));
  if (exact) {
    return exact.id;
  }
  const byProvider = registry.find((row) => row.provider === provider);
  if (byProvider) {
    return byProvider.id;
  }
  return toCanonicalId(provider, model);
}
