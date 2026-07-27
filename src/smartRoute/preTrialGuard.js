import { readCurrentSnapshot } from "./modelSnapshotStore.js";
import { loadResearchCatalog } from "./researchAgent/researchCatalog.js";
import { hasKnownPricing } from "./modelPricing.js";
import { isPremiumModel } from "./optimization.js";
import { rankModelsForTask, CHEAP_TASK_TRIAL_TYPES } from "./modelRanker.js";

/** Fixture IDs that indicate a test snapshot leaked into production. */
export const TEST_FIXTURE_MODEL_IDS = new Set([
  "antigravity:flash",
  "antigravity:default",
  "codex:default",
  "cursor:sonnet",
  "test-fixture:should-not-land",
  "openai:cheap",
  "openai:pricey",
  "local:gemma"
]);

export const DEFAULT_PRE_TRIAL_GUARD = {
  minModelCount: 50,
  requireRefreshOk: true,
  requireNotStale: true,
  requireHashMatch: true,
  rejectTestFixtureIds: true
};

/**
 * Abort live trials when the intelligence snapshot is incomplete or test-polluted.
 */
export async function assertPreTrialSnapshotReady(config, options = {}) {
  const guard = { ...DEFAULT_PRE_TRIAL_GUARD, ...options };
  const errors = [];
  const snapshot = await readCurrentSnapshot();
  const research = await loadResearchCatalog().catch(() => null);

  if (!snapshot?.models?.length) {
    errors.push("missing_model_intelligence_snapshot");
  } else {
    if (snapshot.models.length < guard.minModelCount) {
      errors.push(
        `model_count_below_minimum:${snapshot.models.length}<${guard.minModelCount}`
      );
    }
    if (guard.requireRefreshOk && snapshot.refresh_status !== "ok") {
      errors.push(`refresh_status_not_ok:${snapshot.refresh_status ?? "missing"}`);
    }
    if (guard.requireNotStale && snapshot.stale) {
      errors.push("snapshot_stale");
    }
    if (guard.rejectTestFixtureIds) {
      const fixtures = snapshot.models
        .map((m) => m.canonical_id)
        .filter((id) => TEST_FIXTURE_MODEL_IDS.has(id));
      // Only fail when the snapshot is tiny and dominated by fixtures
      if (
        fixtures.length > 0 &&
        snapshot.models.length <= 5 &&
        fixtures.length >= snapshot.models.length - 1
      ) {
        errors.push(`test_fixture_snapshot_detected:${fixtures.join(",")}`);
      }
    }
  }

  if (guard.requireHashMatch) {
    if (!snapshot?.intelligence_hash) {
      errors.push("missing_intelligence_hash");
    }
    if (!snapshot?.research_hash && !research?.research_hash) {
      errors.push("missing_research_hash");
    }
    if (
      snapshot?.research_hash &&
      research?.research_hash &&
      snapshot.research_hash !== research.research_hash
    ) {
      errors.push("research_hash_mismatch");
    }
  }

  // Runtime hash check against server when base URL provided
  if (options.baseUrl && guard.requireHashMatch) {
    try {
      const headers = { Authorization: `Bearer ${options.apiKey ?? "routerbot"}` };
      const runtime = await fetch(`${options.baseUrl}/api/smart-route/runtime-state`, {
        headers
      }).then((r) => r.json());
      if (runtime.intelligence_hash !== snapshot?.intelligence_hash) {
        errors.push("server_intelligence_hash_mismatch");
      }
      if (runtime.research_hash !== (snapshot?.research_hash ?? research?.research_hash)) {
        errors.push("server_research_hash_mismatch");
      }
      if (runtime.hash_match === false) {
        errors.push("server_hash_match_false");
      }
    } catch (error) {
      errors.push(`runtime_state_unreachable:${error.message}`);
    }
  }

  // Cheap-task winners must not be invalid / premium-only when cheaper exists
  if (snapshot?.models?.length) {
    for (const taskType of CHEAP_TASK_TRIAL_TYPES) {
      const key = taskType === "extract" ? "extract_json" : taskType;
      const ranked = rankModelsForTask(snapshot.models, key, {
        mode: "balanced",
        smartRoute: { ...(config?.routing?.smartRoute ?? {}), mode: "balanced" },
        config,
        costSensitive: true,
        complexity: 1,
        risk: 1
      });
      const winner = ranked[0]?.model;
      if (!winner) {
        errors.push(`no_cheap_task_winner:${taskType}`);
        continue;
      }
      if (!hasKnownPricing(winner.pricing)) {
        errors.push(`invalid_pricing_winner:${winner.canonical_id}`);
      }
      if (winner.canonical_id === "cursor:auto") {
        errors.push("cursor_auto_winner");
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    model_count: snapshot?.models?.length ?? 0,
    intelligence_hash: snapshot?.intelligence_hash ?? null,
    research_hash: snapshot?.research_hash ?? research?.research_hash ?? null,
    refresh_status: snapshot?.refresh_status ?? null,
    stale: snapshot?.stale ?? true
  };
}
