import { extractFeatures } from "./features.js";
import { normalizeRequest } from "./normalize.js";
import { cheapStaticDecision } from "./features.js";
import { applyTaskTypeHint, inferTaskTypeFromPrompt } from "./taskHints.js";
import { loadModelRegistry } from "./registry.js";
import { filterCandidates } from "./candidates.js";
import { rankModelsForTask } from "./modelRanker.js";
import {
  readCurrentSnapshot,
  canUseSnapshotForActiveMode
} from "./modelSnapshotStore.js";
import {
  mapEntryToExecutor,
  selectThroughModelIntelligence,
  usesModelIntelligence
} from "./intelligentSelection.js";
import { passesSafeCheapFilters, mergeSafeCheapTasks } from "./safeCheapTasks.js";
import { getLiveProviderHealth } from "./providerHealthCache.js";
import { loadResearchCatalog } from "./researchAgent/researchCatalog.js";
import { getPricingEvidenceForModel } from "./researchAgent/researchReport.js";


export async function traceSelection(prompt, config, headers = {}) {
  const body = {
    model: config?.server?.exposedModel ?? "routerbot-local",
    messages: [{ role: "user", content: prompt }]
  };
  const settings = { ...(config?.routing?.smartRoute ?? {}), mode: config?.routing?.smartRoute?.mode ?? "shadow_test" };
  const normalized = normalizeRequest(body, headers, config);
  const features = extractFeatures(normalized);
  const registry = await loadModelRegistry(config);
  const snapshot = await readCurrentSnapshot();
  const intelUse = usesModelIntelligence(config, snapshot);
  const gate = canUseSnapshotForActiveMode(config, snapshot);

  let classifier = cheapStaticDecision(features);
  const hinted = inferTaskTypeFromPrompt(prompt);
  if (hinted) {
    classifier = applyTaskTypeHint(classifier, prompt);
  }

  const taskType = classifier.task_type ?? "chat";
  const candidates = filterCandidates(registry, features, settings, classifier);
  const liveProviderHealth = await getLiveProviderHealth(config, {
    maxAgeMs: 120_000,
    providers: ["antigravity"]
  });

  const rankOptions = {
    requiresTools: features.requiresTools,
    requiresVision: features.hasImage,
    requiresStrictJson: features.requiresStrictJson,
    costSensitive: true,
    complexity: classifier.complexity ?? 1,
    risk: classifier.risk ?? 1,
    mode: settings.mode === "shadow_test" ? "balanced" : settings.mode,
    smartRoute: settings,
    config
  };

  const rankedRaw = snapshot?.models?.length
    ? rankModelsForTask(snapshot.models, taskType, rankOptions)
    : [];
  const rankingExplanation = rankedRaw[0]?.explanation ?? null;
  const ranked = rankedRaw.map((row, index) => ({
    rank: index + 1,
    canonical_id: row.model.canonical_id,
    provider: row.model.provider,
    model: row.model.model,
    score: row.ranking.score,
    effective_cost: row.ranking.effective_cost,
    task_quality: row.ranking.task_quality,
    selection_strategy: index === 0 ? rankingExplanation?.selection_strategy : null
  }));

  const rankedIds = new Set(ranked.map((r) => r.canonical_id));
  const excluded = (snapshot?.models ?? [])
    .filter((m) => !rankedIds.has(m.canonical_id))
    .map((m) => {
      const scored = rankModelsForTask([m], taskType, rankOptions);
      return {
        canonical_id: m.canonical_id,
        provider: m.provider,
        reason: scored.length ? "outranked" : "floor_failed"
      };
    });

  let intelPick = null;
  if (intelUse.active) {
    intelPick = await selectThroughModelIntelligence({
      taskType,
      features: {
        requires_tools: features.requiresTools,
        has_image: features.hasImage,
        requires_strict_json: features.requiresStrictJson
      },
      config,
      candidates,
      safeCheapOptions: {
        complexity: classifier.complexity,
        risk: classifier.risk,
        liveProviderHealth
      }
    });
  }

  const rankingWinner = ranked[0]?.canonical_id ?? intelPick?.ranking_winner_canonical_id ?? null;
  const selectedCanonical = intelPick?.selected_canonical_id ?? ranked[0]?.canonical_id ?? null;
  const selectedEntry =
    registry.find((e) => e.id === selectedCanonical) ?? intelPick?.selected ?? null;
  const executor = mapEntryToExecutor(selectedEntry, config);

  const safeCheap = mergeSafeCheapTasks(settings);
  const filterCheck = selectedEntry
    ? passesSafeCheapFilters(selectedEntry, classifier, config, {
        features: rankOptions,
        liveProviderHealth
      })
    : { passes: false, reason: "no_selection" };

  const winnerModel = (snapshot?.models ?? []).find((m) => m.canonical_id === rankingWinner);
  const selectedModel = (snapshot?.models ?? []).find((m) => m.canonical_id === selectedCanonical);
  const researchCatalog = await loadResearchCatalog().catch(() => null);
  const pricingEvidence =
    (await getPricingEvidenceForModel(selectedCanonical).catch(() => null)) ??
    selectedModel?.pricing ??
    winnerModel?.pricing ??
    null;

  const runtimeHash = snapshot?.intelligence_hash ?? null;
  const researchHash = snapshot?.research_hash ?? researchCatalog?.research_hash ?? null;

  return {
    normalized_task: taskType,
    classifier: {
      task_type: classifier.task_type,
      complexity: classifier.complexity,
      risk: classifier.risk,
      confidence: classifier.confidence ?? null
    },
    mode: settings.mode,
    snapshot_usable: gate.allowed,
    uses_model_intelligence: intelUse.active,
    intelligence_hash: runtimeHash,
    research_hash: researchHash,
    candidate_models: candidates.map((c) => ({
      canonical_id: c.id,
      provider: c.provider,
      model: c.model,
      tier: c.tier
    })),
    ranked_models: ranked,
    excluded_models: excluded,
    ranking_winner: rankingWinner,
    selected_canonical_id: selectedCanonical,
    selected_provider: selectedEntry?.provider ?? null,
    selected_model: selectedEntry?.model ?? null,
    execution_adapter: executor.ok ? executor.adapter : null,
    final_attempted_provider: executor.ok ? executor.provider : null,
    final_attempted_model: executor.ok ? executor.model : null,
    override_source: intelPick?.override_source ?? null,
    override_reason: intelPick?.override_reason ?? null,
    safe_cheap_filter: filterCheck,
    intelligence_reason: intelPick?.reason ?? intelUse.reason,
    pricing_evidence: pricingEvidence
      ? {
          canonical_id: selectedCanonical ?? rankingWinner,
          input_per_1m: pricingEvidence.input_per_1m,
          output_per_1m: pricingEvidence.output_per_1m,
          pricing_status: pricingEvidence.pricing_status,
          pricing_invalid_reason: pricingEvidence.pricing_invalid_reason ?? null,
          pricing_source: pricingEvidence.pricing_source ?? pricingEvidence.source_authority,
          source_url: pricingEvidence.source_url ?? null,
          source_hash: pricingEvidence.source_hash ?? null,
          source_authority: pricingEvidence.source_authority ?? null,
          route_context: pricingEvidence.route_context ?? null,
          cost_sensitive_eligible: pricingEvidence.cost_sensitive_eligible,
          fetched_at: pricingEvidence.fetched_at ?? pricingEvidence.pricing_last_checked ?? null
        }
      : null,
    ranking_explanation: rankingExplanation
  };
}

export function formatTraceReport(trace) {
  const lines = [
    `normalized_task: ${trace.normalized_task}`,
    `mode: ${trace.mode} | snapshot_usable: ${trace.snapshot_usable} | uses_model_intelligence: ${trace.uses_model_intelligence}`,
    "",
    "classifier:",
    `  task_type=${trace.classifier.task_type} complexity=${trace.classifier.complexity} risk=${trace.classifier.risk}`,
    "",
    `ranking_winner: ${trace.ranking_winner ?? "none"}`,
    `selected_canonical_id: ${trace.selected_canonical_id ?? "none"}`,
    `execution_adapter: ${trace.execution_adapter ?? "none"}`,
    `final_attempted: ${trace.final_attempted_provider ?? "?"}:${trace.final_attempted_model ?? "?"}`,
    `override_source: ${trace.override_source ?? "none"}`,
    `override_reason: ${trace.override_reason ?? "none"}`,
    `intelligence_hash: ${trace.intelligence_hash ?? "none"}`,
    `research_hash: ${trace.research_hash ?? "none"}`,
    `selection_strategy: ${trace.ranking_explanation?.selection_strategy ?? "none"}`,
    `winner_reason: ${trace.ranking_explanation?.winner_reason ?? "none"}`,
    `premium_blocked: ${trace.ranking_explanation?.premium_blocked ?? "none"}`,
    "",
    "pricing_evidence:"
  ];

  if (trace.pricing_evidence) {
    const pe = trace.pricing_evidence;
    lines.push(
      `  status=${pe.pricing_status ?? "?"} eligible=${pe.cost_sensitive_eligible ?? "?"} source=${pe.pricing_source ?? "?"}`,
      `  input_per_1m=${pe.input_per_1m} output_per_1m=${pe.output_per_1m} route=${pe.route_context ?? "?"}`,
      `  source_url=${pe.source_url ?? "none"}`,
      `  source_hash=${pe.source_hash ?? "none"}`,
      `  invalid_reason=${pe.pricing_invalid_reason ?? "none"}`
    );
  } else {
    lines.push("  none");
  }

  lines.push("", "ranked_models:");

  for (const row of trace.ranked_models.slice(0, 8)) {
    lines.push(
      `  #${row.rank} ${row.canonical_id} score=${row.score} cost=${row.effective_cost}`
    );
  }

  if (trace.excluded_models.length) {
    lines.push("", "excluded_models (sample):");
    for (const row of trace.excluded_models.slice(0, 8)) {
      lines.push(`  ${row.canonical_id} | ${row.reason}`);
    }
  }

  if (trace.ranking_winner && trace.selected_canonical_id === trace.ranking_winner) {
    lines.push("", "OK: selected canonical matches ranking winner");
  } else if (trace.uses_model_intelligence && trace.ranking_winner) {
    lines.push(
      "",
      `MISMATCH: ranking winner ${trace.ranking_winner} != selected ${trace.selected_canonical_id}`
    );
  }

  return lines.join("\n");
}
