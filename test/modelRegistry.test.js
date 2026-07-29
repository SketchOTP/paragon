import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRegistry } from "../src/routing/modelRegistry.js";
import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";
import { PROVIDER_DEFAULT_MODEL_ID } from "../src/modelCapability.js";

function baseConfig(overrides = {}) {
  return {
    providers: {
      claude: {
        enabled: true,
        type: "builtin",
        model: "claude-opus-5",
        models: [
          { id: "claude-opus-5", name: "Opus 5" },
          { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" }
        ]
      },
      antigravity: {
        enabled: true,
        type: "builtin",
        model: "gemini-3.1-pro-high",
        models: [{ id: "gemini-3.1-pro-high", name: "gemini-3.1-pro-high" }]
      },
      disabled: {
        enabled: false,
        type: "builtin",
        model: "x",
        models: [{ id: "x", name: "x" }]
      },
      ...overrides
    }
  };
}

/** Catalog with the two providers baseConfig() enables, all models eligible. */
function assessedCatalog({ claudeModels, antigravityModels } = {}) {
  const catalog = defaultCatalog();
  replaceProviderModels(
    catalog,
    "claude",
    claudeModels ?? [
      { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" },
      { modelId: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", state: "validated", discoverySource: "documented_candidate" }
    ]
  );
  replaceProviderModels(
    catalog,
    "antigravity",
    antigravityModels ?? [{ modelId: "gemini-3.1-pro-high", displayName: "gemini-3.1-pro-high", state: "exposed", discoverySource: "cli_command" }]
  );
  return catalog;
}

test("buildModelRegistry skips disabled providers", () => {
  const registry = buildModelRegistry(baseConfig(), {}, assessedCatalog());
  assert.ok(!registry.some((e) => e.provider === "disabled"));
});

test("buildModelRegistry produces one entry per catalog-eligible model, not one per provider", () => {
  const registry = buildModelRegistry(baseConfig(), {}, assessedCatalog());
  const claudeEntries = registry.filter((e) => e.provider === "claude");
  assert.equal(claudeEntries.length, 2);
  assert.ok(claudeEntries.some((e) => e.model === "claude-opus-5"));
  assert.ok(claudeEntries.some((e) => e.model === "claude-haiku-4-5-20251001"));
});

test("buildModelRegistry marks catalog-eligible entries automatically eligible with isolated tool risk", () => {
  const registry = buildModelRegistry(baseConfig(), {}, assessedCatalog());
  const antigravity = registry.find((e) => e.provider === "antigravity");
  assert.equal(antigravity.automaticEligibility, true);
  assert.equal(antigravity.toolExecutionRisk, "isolated");
  const claude = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  assert.equal(claude.automaticEligibility, true);
  assert.equal(claude.toolExecutionRisk, "isolated");
});

test("buildModelRegistry infers a well-documented context window for claude, leaves unknowns null", () => {
  const registry = buildModelRegistry(baseConfig(), {}, assessedCatalog());
  const claude = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  assert.equal(claude.contextWindow, 200000);
  const antigravity = registry.find((e) => e.provider === "antigravity");
  assert.equal(antigravity.contextWindow, null, "unknown context windows must stay null, not fabricated");
});

test("buildModelRegistry reflects live health from the statuses snapshot without re-probing", () => {
  const registry = buildModelRegistry(baseConfig(), { claude: { ok: true }, antigravity: { ok: false } }, assessedCatalog());
  assert.equal(registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5").health, "healthy");
  assert.equal(registry.find((e) => e.provider === "antigravity").health, "unhealthy");
});

test("buildModelRegistry cost class heuristic: haiku is economy, opus is premium", () => {
  const registry = buildModelRegistry(baseConfig(), {}, assessedCatalog());
  assert.equal(registry.find((e) => e.model === "claude-haiku-4-5-20251001").costClass, "economy");
  assert.equal(registry.find((e) => e.model === "claude-opus-5").costClass, "premium");
});

// PARAGON-D-004C: catalog state is a hard filter on what routing can see.
test("buildModelRegistry: a rejected model is left out of the registry entirely — not merely marked ineligible", () => {
  const catalog = assessedCatalog({
    claudeModels: [
      { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" },
      { modelId: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", state: "rejected", discoverySource: "documented_candidate" }
    ]
  });
  const registry = buildModelRegistry(baseConfig(), {}, catalog);
  assert.ok(registry.some((e) => e.provider === "claude" && e.model === "claude-opus-5"));
  assert.equal(
    registry.find((e) => e.provider === "claude" && e.model === "claude-haiku-4-5-20251001"),
    undefined,
    "the registry (and therefore routing/ranking) must never list a rejected model at all"
  );
});

test("buildModelRegistry: an unknown (candidate-only, never validated) model never appears in the registry", () => {
  const catalog = assessedCatalog({
    claudeModels: [
      { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" },
      { modelId: "claude-mythos-5", displayName: "Mythos 5", state: "unknown", discoverySource: "documented_candidate" }
    ]
  });
  const registry = buildModelRegistry(baseConfig(), {}, catalog);
  assert.ok(registry.some((e) => e.provider === "claude" && e.model === "claude-opus-5"));
  assert.ok(
    !registry.some((e) => e.provider === "claude" && e.model === "claude-mythos-5"),
    "an unvalidated model must not be usable by routing — it must not even be listed"
  );
});

test("buildModelRegistry: a validated entry past the configured TTL is dropped from the registry", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(
    catalog,
    "claude",
    [{ modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" }],
    { now: new Date(Date.now() - 48 * 3_600_000).toISOString() }
  );
  const cfg = baseConfig();
  cfg.modelCatalog = { validationTtlHours: 24 };
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.equal(
    registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5"),
    undefined
  );
});

test("buildModelRegistry reflects a completed catalog refresh immediately — no separate 'refresh the registry' step exists", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-opus-5", displayName: "Opus 5", state: "unknown", discoverySource: "documented_candidate" }
  ]);
  const before = buildModelRegistry(baseConfig(), {}, catalog);
  assert.ok(!before.some((e) => e.provider === "claude" && e.model === "claude-opus-5"));

  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" }
  ]);
  const after = buildModelRegistry(baseConfig(), {}, catalog);
  assert.ok(after.some((e) => e.provider === "claude" && e.model === "claude-opus-5"));
});

// PARAGON-D-004C1 P0-4: the unassessed-provider config-trust fallback is gone.
test("buildModelRegistry: an unassessed provider contributes zero eligible models and is reported pending_assessment", () => {
  const catalog = defaultCatalog(); // no buckets at all
  const registry = buildModelRegistry(baseConfig(), {}, catalog);
  assert.equal(registry.filter((e) => e.automaticEligibility).length, 0, "no provider may be routable without a completed assessment");
  const claudeRow = registry.find((e) => e.provider === "claude");
  assert.equal(claudeRow.modelState, "pending_assessment");
  assert.equal(claudeRow.pendingAssessment, true);
  assert.equal(claudeRow.model, null, "a pending provider must not advertise a configured model id");
});

test("buildModelRegistry: configured providerConfig.models are never trusted without a catalog bucket", () => {
  const catalog = defaultCatalog();
  const registry = buildModelRegistry(baseConfig(), {}, catalog);
  for (const configured of ["claude-opus-5", "claude-haiku-4-5-20251001", "gemini-3.1-pro-high"]) {
    assert.ok(!registry.some((e) => e.model === configured), `${configured} must not be routable from config alone`);
  }
});

test("buildModelRegistry: omitting the catalog entirely yields no routable models (no implicit config trust)", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  assert.equal(registry.filter((e) => e.automaticEligibility).length, 0);
});

test("buildModelRegistry: a failed refresh leaves a provider unavailable rather than falling back to config trust", () => {
  // Simulates lmstudio in production: enabled, configured models present,
  // HTTP discovery failing, so no catalog bucket was ever created.
  const cfg = baseConfig({
    lmstudio: {
      enabled: true,
      type: "http",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "google/gemma-4-26b-a4b-qat",
      models: [
        { id: "google/gemma-4-26b-a4b-qat", name: "gemma" },
        { id: "jina-embeddings-v5-text-small-retrieval", name: "jina" }
      ]
    }
  });
  const registry = buildModelRegistry(cfg, {}, assessedCatalog());
  const lmstudioRoutable = registry.filter((e) => e.provider === "lmstudio" && e.automaticEligibility);
  assert.equal(lmstudioRoutable.length, 0);
  assert.equal(registry.find((e) => e.provider === "lmstudio").pendingAssessment, true);
});

// PARAGON-D-004C1 P0-5: chat-capability gate.
test("buildModelRegistry: embedding models are excluded from the chat registry even when catalog-exposed", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "lmstudio", [
    { modelId: "google/gemma-4-26b-a4b-qat", displayName: "gemma", state: "exposed", discoverySource: "http_models_endpoint" },
    { modelId: "jina-embeddings-v5-text-small-retrieval", displayName: "jina", state: "exposed", discoverySource: "http_models_endpoint" },
    { modelId: "text-embedding-nomic-embed-text-v1.5", displayName: "nomic", state: "exposed", discoverySource: "http_models_endpoint" }
  ]);
  const cfg = { providers: { lmstudio: { enabled: true, type: "http", baseUrl: "http://x", model: "", models: [] } } };
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.deepEqual(
    registry.map((e) => e.model),
    ["google/gemma-4-26b-a4b-qat"],
    "only the chat-capable model may enter the registry"
  );
});

test("buildModelRegistry: provider metadata declaring an embedding model excludes it even when the id looks chat-like", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "lmstudio", [
    { modelId: "some-innocuous-name", displayName: "x", state: "exposed", discoverySource: "http_models_endpoint", metadata: { type: "embeddings" } },
    { modelId: "chatty-model", displayName: "y", state: "exposed", discoverySource: "http_models_endpoint", metadata: { type: "llm" } }
  ]);
  const cfg = { providers: { lmstudio: { enabled: true, type: "http", baseUrl: "http://x", model: "", models: [] } } };
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.deepEqual(registry.map((e) => e.model), ["chatty-model"]);
});

test("buildModelRegistry: a validated provider-default entry is represented explicitly", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "codex", [
    { modelId: PROVIDER_DEFAULT_MODEL_ID, displayName: "Provider default", state: "validated", discoverySource: "provider_default" }
  ]);
  const cfg = { providers: { codex: { enabled: true, type: "builtin", model: "", models: [] } } };
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.equal(registry.length, 1);
  assert.equal(registry[0].model, PROVIDER_DEFAULT_MODEL_ID);
  assert.equal(registry[0].providerDefault, true);
  assert.equal(registry[0].automaticEligibility, true);
  assert.equal(registry[0].capabilities.chatCompletions, true);
});
