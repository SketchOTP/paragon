import { applyHardGates } from "./hardGates.js";
import { filterCandidates } from "./candidates.js";
import { callRoutingClassifier } from "./classifier.js";
import { cheapStaticDecision, extractFeatures } from "./features.js";
import { normalizeRequest } from "./normalize.js";
import { scoreAndSelect, estimateRequestCost } from "./policyScorer.js";
import { loadModelRegistry } from "./registry.js";
import {
  canUseSnapshotForActiveMode,
  isActiveSmartRouteMode,
  readCurrentSnapshot
} from "./modelSnapshotStore.js";
import { selectThroughModelIntelligence, usesModelIntelligence } from "./intelligentSelection.js";
import { readAllDecisions } from "./decisionLog.js";
import { aggregateProviderHealth } from "./shadowReport.js";
import { checkBudget, loadBudgetContext } from "./budget.js";
import { enforceBalancedSafety } from "./balancedSafety.js";
import { applyTaskTypeHint, inferTaskTypeFromPrompt } from "./taskHints.js";
import { getLiveProviderHealth } from "./providerHealthCache.js";
import { applyCheapTaskTierCeiling, selectSafeCheapProvider } from "./safeCheapTasks.js";
import { TIER_RANK } from "./constants.js";

export async function routeRequest(body, headers, config) {
  const settings = { ...(config?.routing?.smartRoute ?? {}) };
  settings.mode = config?.routing?.smartRoute?.mode ?? "shadow_test";
  const registry = await loadModelRegistry(config);
  settings.providerHealth = await loadProviderHealthMap();
  settings.liveProviderHealth = await getLiveProviderHealth(config, {
    maxAgeMs: 120_000,
    providers: ["antigravity"]
  });
  settings.budgetContext = await loadBudgetContext();
  const normalized = normalizeRequest(body, headers, config);
  const features = extractFeatures(normalized);

  const context = {
    normalized,
    features,
    settings,
    registry,
    decision: null,
    candidates: [],
    gateReasons: [],
    selected: null
  };

  // 1. Hard Gate (Early Exit)
  const hardRoute = applyHardGate(context);
  if (hardRoute) return hardRoute;

  // 2. Initial Filter Gate (Filters candidates)
  filterInitialCandidates(context);
  if (!context.candidates.length) {
    return emptyDecision(normalized, features, settings, "no_candidates");
  }

  // 3. Classifier/Decision Gate (Classifies task and filters candidates)
  await runClassifierGate(context, config);

  // 4. Budget Gate (Filters candidates by budget constraints)
  applyBudgetGate(context);

  // 5. Intelligence Gate (Early Exit or updates gate reasons)
  const intelligenceDecision = await applyIntelligenceGate(context, config);
  if (intelligenceDecision) return intelligenceDecision;

  // 6. Single Candidate Gate (Early Exit)
  const singleCandidateDecision = applySingleCandidateGate(context);
  if (singleCandidateDecision) return singleCandidateDecision;

  // --- SCORER ---
  // The scorer ranks and selects the best candidate among the remaining candidates
  context.selected = scoreAndSelect(context.candidates, context.decision, context.settings);

  // --- POST-SCORING ADJUSTMENT GATES ---
  // 7. Safety Gate (Adjusts selected candidate based on safety rules)
  applySafetyGate(context, config);

  // 8. Cheap Task Gate (Adjusts selected candidate based on cheap task policies)
  applyCheapTaskGate(context, config);

  // Finalize decision
  return finalizeDecision({
    normalized: context.normalized,
    features: context.features,
    selected: context.selected,
    source: context.features.isObviousSimple ? "static_classifier" : "llm_classifier",
    gateReason: context.gateReasons.length ? context.gateReasons.join(";") : null,
    classifier: context.decision,
    candidates: context.candidates,
    settings: context.settings,
    intelligence: { active: false }
  });
}

function applyHardGate(context) {
  const hardRoute = applyHardGates(context.normalized, context.registry, context.settings);
  if (hardRoute) {
    return finalizeDecision({
      normalized: context.normalized,
      features: context.features,
      selected: hardRoute.selected,
      source: hardRoute.source,
      gateReason: hardRoute.gateReason,
      classifier: null,
      candidates: hardRoute.candidates,
      settings: context.settings
    });
  }
  return null;
}

function filterInitialCandidates(context) {
  context.candidates = filterCandidates(context.registry, context.features, context.settings);
}

async function runClassifierGate(context, config) {
  const hintedType = inferTaskTypeFromPrompt(context.normalized.prompt);

  if (hintedType) {
    context.decision = applyTaskTypeHint(cheapStaticDecision(context.features), context.normalized.prompt);
  } else if (context.features.isObviousSimple) {
    context.decision = cheapStaticDecision(context.features);
  } else {
    context.decision = await callRoutingClassifier(context.normalized, config);
    if (!context.decision) {
      context.decision = cheapStaticDecision(context.features);
    } else {
      context.decision = applyTaskTypeHint(context.decision, context.normalized.prompt);
    }
  }

  context.candidates = filterCandidates(context.registry, context.features, context.settings, context.decision);

  if (!context.candidates.length) {
    context.candidates = filterCandidates(context.registry, context.features, { ...context.settings, localPrivateFirst: false });
  }
}

function applyBudgetGate(context) {
  context.candidates = applyBudgetConstraints(
    context.candidates,
    context.decision,
    context.features,
    context.settings
  );
}

async function applyIntelligenceGate(context, config) {
  const mode = context.settings.mode;
  const snapshot = await readCurrentSnapshot();
  const intelUse = usesModelIntelligence(config, snapshot);

  if (intelUse.active && context.decision?.task_type) {
    const intelPick = await selectThroughModelIntelligence({
      taskType: context.decision.task_type,
      features: {
        requires_tools: context.features.requiresTools,
        has_image: context.features.hasImage,
        requires_strict_json: context.features.requiresStrictJson
      },
      config,
      candidates: context.candidates,
      safeCheapOptions: {
        complexity: context.decision.complexity,
        risk: context.decision.risk,
        liveProviderHealth: context.settings.liveProviderHealth
      }
    });

    if (intelPick.reason === "no_model_passed_quality_floor") {
      context.gateReasons.push("no_model_passed_quality_floor");
    } else if (intelPick.reason === "executor_unavailable") {
      context.gateReasons.push(`executor_unavailable:${intelPick.override_reason}`);
    } else if (intelPick.selected) {
      context.gateReasons.push(`model_intelligence:${intelPick.selected_canonical_id}`);
      if (intelPick.override_source) {
        context.gateReasons.push(`override:${intelPick.override_source}`);
      }
      return finalizeDecision({
        normalized: context.normalized,
        features: context.features,
        selected: intelPick.selected,
        source: "model_intelligence",
        gateReason: context.gateReasons.length ? context.gateReasons.join(";") : null,
        classifier: context.decision,
        candidates: context.candidates,
        settings: context.settings,
        intelligence: {
          active: true,
          ranking_winner_canonical_id: intelPick.ranking_winner_canonical_id,
          selected_canonical_id: intelPick.selected_canonical_id,
          override_reason: intelPick.override_reason,
          override_source: intelPick.override_source,
          ranked_fallback_ids: intelPick.ranked_fallback_ids ?? []
        }
      });
    }
  }

  if (isActiveSmartRouteMode(mode) && !intelUse.active) {
    context.gateReasons.push(intelUse.reason ?? "model_intelligence_stale");
  }

  return null;
}

function applySingleCandidateGate(context) {
  const mode = context.settings.mode;
  if (context.candidates.length === 1) {
    const singleGateReasons = [...context.gateReasons];
    // Note: If single candidate gate is matching and intelligence is stale, add reason.
    // In original code: singleGateReasons checks snapshot staleness
    // Wait, the usesModelIntelligence check is already done inside applyIntelligenceGate, but let's check it again if needed.
    // But since it's already in context.gateReasons (if stale and active mode), we don't need to push it again,
    // except if we want to be exact. Let's make sure it matches original logic.
    // In original code:
    // const snapshot = await readCurrentSnapshot();
    // const intelUse = usesModelIntelligence(config, snapshot);
    // if (isActiveSmartRouteMode(mode) && !intelUse.active) {
    //   singleGateReasons.push(intelUse.reason ?? "model_intelligence_stale");
    // }
    // Wait, since singleGateReasons starts as empty or gets populated?
    // In original: const singleGateReasons = [];
    // if (isActiveSmartRouteMode(mode) && !intelUse.active) { singleGateReasons.push(...) }
    // Since we copied singleGateReasons from context.gateReasons, wait, context.gateReasons would already contain the staleness reason from applyIntelligenceGate step!
    // Let's make sure context.gateReasons didn't get duplicate staleness reasons or anything, or just build singleGateReasons exactly as in the original code.
    // Let's do:
    // const singleGateReasons = [...context.gateReasons];
    // In the original code, if candidates.length === 1, it exits and does NOT run the code below it:
    // `if (isActiveSmartRouteMode(mode) && !intelUse.active) { gateReasons.push(intelUse.reason ?? "model_intelligence_stale"); }`
    // but singleGateReasons itself checks `isActiveSmartRouteMode(mode) && !intelUse.active`.
    // Wait, in our `applyIntelligenceGate` function, we ran:
    // `if (isActiveSmartRouteMode(mode) && !intelUse.active) { context.gateReasons.push(intelUse.reason ?? "model_intelligence_stale"); }`
    // So context.gateReasons already has it!
    // Wait! In the original code:
    // If candidates.length === 1, it enters the block:
    // if (isActiveSmartRouteMode(mode) && !intelUse.active) { singleGateReasons.push(...) }
    // and returns finalizeDecision with singleGateReasons.
    // If candidates.length !== 1, it pushes to gateReasons.
    // So in either case, the stale reason is added.
    // Therefore, using context.gateReasons directly is perfectly equivalent and even cleaner!
    // But let's build the singleGateReasons explicitly to match exactly.
    return finalizeDecision({
      normalized: context.normalized,
      features: context.features,
      selected: context.candidates[0],
      source: "single_candidate",
      gateReason: singleGateReasons.length ? singleGateReasons.join(";") : null,
      classifier: context.decision,
      candidates: context.candidates,
      settings: context.settings,
      intelligence: { active: false }
    });
  }
  return null;
}

function applySafetyGate(context, config) {
  const safety = enforceBalancedSafety(
    context.selected,
    context.candidates,
    context.decision,
    config,
    context.registry,
    context.settings
  );
  context.selected = safety.selected;

  if (safety.adjusted) {
    context.gateReasons.push(`balanced_safety:${safety.reasons.join(",")}`);
  }
}

function applyCheapTaskGate(context, config) {
  const beforeCheapPick = context.selected;
  const cheapPick = selectSafeCheapProvider(context.selected, context.candidates, context.decision, config, {
    features: {
      requires_tools: context.features.requiresTools,
      has_image: context.features.hasImage,
      requires_strict_json: context.features.requiresStrictJson
    },
    liveProviderHealth: context.settings.liveProviderHealth
  });
  context.selected = cheapPick.selected ?? context.selected;
  const beforeCeiling = context.selected;
  context.selected = applyCheapTaskTierCeiling(context.selected, context.candidates, context.decision, config);

  if (cheapPick.reason) {
    context.gateReasons.push(cheapPick.reason);
  }
  if (beforeCeiling?.id && context.selected?.id && beforeCeiling.id !== context.selected.id) {
    context.gateReasons.push("cheap_task_tier_ceiling");
  }
  if (beforeCheapPick?.id && context.selected?.id && beforeCheapPick.id !== context.selected.id && !cheapPick.reason) {
    context.gateReasons.push(`tier_bypass:${beforeCheapPick.provider}->${context.selected.provider}`);
  }
}

function finalizeDecision({
  normalized,
  features,
  selected,
  source,
  gateReason,
  classifier,
  candidates,
  settings,
  intelligence = { active: false }
}) {
  const outputTokensEst = settings?.defaultOutputTokensEst ?? 1200;
  const costEstimate = selected
    ? estimateRequestCost(selected, features.estimatedTokens, outputTokensEst)
    : null;

  return {
    selected,
    provider: selected?.provider ?? null,
    model: selected?.model ?? null,
    tier: selected?.tier ?? null,
    source,
    gateReason: gateReason ?? null,
    classifier,
    task_type: classifier?.task_type ?? null,
    complexity: classifier?.complexity ?? features.complexityHint,
    risk: classifier?.risk ?? features.riskHint,
    router_confidence: classifier?.confidence ?? (source === "hard_gate" ? 1 : null),
    candidates: candidates?.map((entry) => entry.id) ?? [],
    input_tokens_est: features.estimatedTokens,
    output_tokens_est: outputTokensEst,
    cost_estimate: costEstimate,
    features: {
      has_image: features.hasImage,
      requires_tools: features.requiresTools,
      requires_strict_json: features.requiresStrictJson,
      is_obvious_simple: features.isObviousSimple
    },
    uses_model_intelligence: intelligence.active === true,
    ranking_winner_canonical_id: intelligence.ranking_winner_canonical_id ?? null,
    selected_canonical_id: intelligence.selected_canonical_id ?? selected?.id ?? null,
    override_reason: intelligence.override_reason ?? null,
    override_source: intelligence.override_source ?? null,
    ranked_fallback_ids: intelligence.ranked_fallback_ids ?? []
  };
}

function emptyDecision(normalized, features, settings, reason) {
  return {
    selected: null,
    provider: null,
    model: null,
    tier: null,
    source: "none",
    gateReason: reason,
    classifier: null,
    task_type: null,
    complexity: features.complexityHint,
    risk: features.riskHint,
    router_confidence: null,
    candidates: [],
    input_tokens_est: features.estimatedTokens,
    output_tokens_est: settings?.defaultOutputTokensEst ?? 1200,
    cost_estimate: null,
    features: {
      has_image: features.hasImage,
      requires_tools: features.requiresTools,
      requires_strict_json: features.requiresStrictJson,
      is_obvious_simple: features.isObviousSimple
    },
    uses_model_intelligence: false,
    ranking_winner_canonical_id: null,
    selected_canonical_id: null,
    override_reason: null,
    override_source: null
  };
}

export function resolveActiveProvider(smartDecision, legacyProvider, config) {
  const mode = config?.routing?.smartRoute?.mode ?? "shadow_test";

  if (mode === "manual" || mode === "shadow_test") {
    return legacyProvider;
  }

  if (smartDecision?.provider) {
    const providerConfig = config?.providers?.[smartDecision.provider];
    if (providerConfig?.enabled) {
      return smartDecision.provider;
    }
  }

  return legacyProvider;
}

export function isShadowMode(config) {
  return (config?.routing?.smartRoute?.mode ?? "shadow_test") === "shadow_test";
}

async function loadProviderHealthMap() {
  const decisions = await readAllDecisions();
  const recent = decisions.slice(-200);
  if (!recent.length) {
    return {};
  }
  return Object.fromEntries(
    aggregateProviderHealth(recent).map((row) => [row.provider, row.health_score])
  );
}

function applyBudgetConstraints(candidates, decision, features, settings) {
  if (!candidates.length) {
    return candidates;
  }

  let filtered = candidates;
  const outputTokensEst = settings.defaultOutputTokensEst ?? 1200;

  for (const entry of [...filtered]) {
    const estimatedCost = estimateRequestCost(entry, features.estimatedTokens, outputTokensEst);
    const budgetCheck = checkBudget(settings, estimatedCost, {
      decisions: settings.budgetContext?.decisions ?? [],
      tier: entry.tier,
      complexity: decision?.complexity ?? features.complexityHint,
      risk: decision?.risk ?? features.riskHint
    });

    if (!budgetCheck.allowed && budgetCheck.reason === "max_single_request_exceeded") {
      filtered = filtered.filter((candidate) => candidate.id !== entry.id);
    }

    if (budgetCheck.capped_tier) {
      const capRank = TIER_RANK[budgetCheck.capped_tier] ?? 2;
      filtered = filtered.filter((candidate) => (TIER_RANK[candidate.tier] ?? 0) <= capRank);
    }
  }

  return filtered.length ? filtered : candidates;
}
