/**
 * PARAGON-D-004C1 routing-integrity regressions.
 *
 * Unit-level coverage for the P0 corrections. Each test names the defect it
 * pins so a future change that reintroduces a bypass fails here with an
 * explanation rather than a bare assertion diff. HTTP-level coverage of the
 * same contract lives in routingIntegrity.api.test.js.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { selectRoute, buildRankedAttempts, verifyAttemptsAgainstRegistry } from "../src/routing/router.js";
import { buildModelRegistry } from "../src/routing/modelRegistry.js";
import { defaultCatalog, replaceProviderModels, reconcileConfiguredModels } from "../src/modelCatalog.js";
import { classifyChatCapability, PROVIDER_DEFAULT_MODEL_ID } from "../src/modelCapability.js";
import { resetForTests } from "../src/orchestration/liveEnforcement.js";

test.beforeEach(() => {
  resetForTests();
});

function config(overrides = {}) {
  return {
    routing: { taskRoutes: {}, defaultProvider: "claude", fallbackChain: ["claude", "codex"] },
    providers: {
      claude: { enabled: true, model: "claude-opus-5", models: [{ id: "claude-opus-5", name: "Opus 5" }] },
      codex: { enabled: true, model: "gpt-5.4", models: [{ id: "gpt-5.4", name: "GPT-5.4" }] },
      ...overrides
    }
  };
}

function catalogWith(entriesByProvider) {
  const catalog = defaultCatalog();
  for (const [provider, entries] of Object.entries(entriesByProvider)) {
    replaceProviderModels(catalog, provider, entries);
  }
  return catalog;
}

const validated = (modelId, extra = {}) => ({
  modelId,
  displayName: modelId,
  state: "validated",
  discoverySource: "documented_candidate",
  ...extra
});

// ---------------------------------------------------------------- P0-1

test("1. no static fallback exists when the eligible registry is empty — selectRoute returns null rather than a config-derived route", () => {
  const cfg = config();
  // Providers configured and enabled, but the catalog rejected everything.
  const catalog = catalogWith({
    claude: [{ ...validated("claude-opus-5"), state: "rejected" }],
    codex: [{ ...validated("gpt-5.4"), state: "rejected" }]
  });
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    catalog
  });
  assert.equal(route, null, "an empty eligible set must not be papered over with routing.fallbackChain");
});

test("1b. routing.fallbackChain / defaultProvider are no longer an independent dispatch path", async () => {
  const providerFallback = await import("../src/providerFallback.js");
  assert.equal(providerFallback.buildProviderAttempts, undefined);
});

// ---------------------------------------------------------------- P0-2

test("2. a rejected configured model cannot be selected even though it is still in providerConfig.model", () => {
  const cfg = config();
  const catalog = catalogWith({
    claude: [{ ...validated("claude-opus-5"), state: "rejected" }],
    codex: [validated("gpt-5.4")]
  });
  const route = selectRoute({ config: cfg, statuses: {}, taskProfile: { taskType: "code", estimatedInputTokens: 100 }, catalog });
  assert.equal(route.provider, "codex");
  assert.equal(route.model, "gpt-5.4");
});

test("5. a forced rejected model is denied, never dispatched", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [{ ...validated("claude-opus-5"), state: "rejected" }], codex: [validated("gpt-5.4")] });
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    hints: { forceProvider: "claude", forceModel: "claude-opus-5" },
    catalog
  });
  assert.equal(route.rejected, true);
  assert.equal(route.reasonCode, "routing.forcedModelNotEligible");
});

test("5b. a forced model that exists nowhere in the catalog is denied, never falls back to providerConfig.model", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] });
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    hints: { forceProvider: "claude", forceModel: "totally-made-up" },
    catalog
  });
  assert.equal(route.rejected, true);
  assert.equal(route.reasonCode, "routing.forcedModelNotEligible");
});

test("6. a forced provider with no eligible model is denied", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [{ ...validated("claude-opus-5"), state: "unknown" }], codex: [validated("gpt-5.4")] });
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    hints: { forceProvider: "claude" },
    catalog
  });
  assert.equal(route.rejected, true);
  assert.equal(route.reasonCode, "routing.forcedProviderNotEligible");
});

test("6b. a forced provider that is disabled is denied", () => {
  const cfg = config();
  cfg.providers.claude.enabled = false;
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    hints: { forceProvider: "claude" },
    catalog
  });
  assert.equal(route.rejected, true);
  assert.equal(route.reasonCode, "routing.forcedProviderNotEligible");
});

test("7. forced routing still obeys the caller's max cost class", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] }); // opus -> premium
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "quick", estimatedInputTokens: 100 },
    hints: { forceProvider: "claude", forceModel: "claude-opus-5", maxCostClass: "economy" },
    catalog
  });
  assert.equal(route.rejected, true, "the cost ceiling was previously bypassed entirely by forcing");
  assert.equal(route.reasonCode, "routing.forcedModelNotEligible");
});

test("8. forced routing still obeys context limits", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] }); // 200k context
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 500000 },
    hints: { forceProvider: "claude", forceModel: "claude-opus-5" },
    catalog
  });
  assert.equal(route.rejected, true);
  assert.match(route.message, /eligibility gate/);
});

test("8b. forced routing still obeys provider health", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] });
  const route = selectRoute({
    config: cfg,
    statuses: { claude: { ok: false } },
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    hints: { forceProvider: "claude" },
    catalog
  });
  assert.equal(route.rejected, true);
});

test("a forced route that passes every gate is honored and reports hint.forceProvider", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const route = selectRoute({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    hints: { forceProvider: "claude", forceModel: "claude-opus-5" },
    catalog
  });
  assert.equal(route.rejected, undefined);
  assert.equal(route.provider, "claude");
  assert.equal(route.model, "claude-opus-5");
  assert.equal(route.reasonCode, "hint.forceProvider");
  assert.equal(route.confidence, "explicit");
});

// ---------------------------------------------------------------- P0-3

test("3. a configured model is cleared after the catalog authoritatively removes it", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [{ ...validated("claude-opus-5"), state: "retired" }], codex: [validated("gpt-5.4")] });
  const { config: next, cleared } = reconcileConfiguredModels(cfg, catalog);
  assert.deepEqual(cleared, [{ provider: "claude", model: "claude-opus-5", previousState: "retired" }]);
  assert.equal(next.providers.claude.model, "", "cleared, never replaced with an arbitrary catalog model");
  assert.equal(next.providers.codex.model, "gpt-5.4", "an eligible configured model is left alone");
});

test("4. startup reconciliation clears a model that is absent from the catalog entirely", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("some-other-model")] });
  const { config: next, cleared } = reconcileConfiguredModels(cfg, catalog);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].previousState, "absent_from_catalog");
  assert.equal(next.providers.claude.model, "");
});

test("3b. reconciliation preserves unrelated provider configuration and credentials", () => {
  const cfg = config({
    lmstudio: { enabled: true, type: "http", baseUrl: "http://x/v1", apiKey: "secret-token", model: "gone", models: [] }
  });
  const catalog = catalogWith({ lmstudio: [validated("something-else")] });
  const { config: next } = reconcileConfiguredModels(cfg, catalog);
  assert.equal(next.providers.lmstudio.model, "");
  assert.equal(next.providers.lmstudio.apiKey, "secret-token");
  assert.equal(next.providers.lmstudio.baseUrl, "http://x/v1");
  assert.equal(next.providers.lmstudio.enabled, true);
});

test("3c. reconciliation does not touch a provider the catalog has never assessed", () => {
  const cfg = config();
  const catalog = catalogWith({ codex: [validated("gpt-5.4")] }); // no claude bucket
  const { config: next, cleared } = reconcileConfiguredModels(cfg, catalog);
  assert.equal(cleared.length, 0);
  assert.equal(next.providers.claude.model, "claude-opus-5", "no authoritative refresh has contradicted this yet");
});

test("3d. reconciliation leaves an intentionally empty configured model alone", () => {
  const cfg = config();
  cfg.providers.claude.model = "";
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] });
  const { cleared } = reconcileConfiguredModels(cfg, catalog);
  assert.equal(cleared.length, 0);
});

// ---------------------------------------------------------------- P0-4

test("9. an unassessed provider contributes zero eligible models", () => {
  const cfg = config();
  const registry = buildModelRegistry(cfg, {}, defaultCatalog());
  assert.equal(registry.filter((e) => e.automaticEligibility).length, 0);
  assert.ok(registry.every((e) => e.pendingAssessment));
});

test("10. a failed refresh for an unassessed provider does not restore config trust", () => {
  // A failed refresh never creates a bucket (refreshProviderCatalog throws
  // before replaceProviderModels), so the provider stays bucket-less.
  const cfg = config({
    lmstudio: {
      enabled: true,
      type: "http",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "google/gemma-4-26b-a4b-qat",
      models: [{ id: "google/gemma-4-26b-a4b-qat", name: "gemma" }]
    }
  });
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.equal(registry.filter((e) => e.provider === "lmstudio" && e.automaticEligibility).length, 0);
  assert.equal(registry.find((e) => e.provider === "lmstudio").modelState, "pending_assessment");
});

test("11. provider-default routing requires an explicitly validated provider-default entry", () => {
  const cfg = { routing: { taskRoutes: {} }, providers: { codex: { enabled: true, model: "", models: [] } } };

  // No provider-default entry -> nothing routable, no implicit empty-model route.
  const withoutDefault = buildModelRegistry(cfg, {}, catalogWith({ codex: [validated("gpt-5.4")] }));
  assert.ok(!withoutDefault.some((e) => e.providerDefault));

  const withDefault = buildModelRegistry(
    cfg,
    {},
    catalogWith({ codex: [{ ...validated(PROVIDER_DEFAULT_MODEL_ID), discoverySource: "provider_default" }] })
  );
  const entry = withDefault.find((e) => e.providerDefault);
  assert.ok(entry, "a validated provider-default must be an explicit registry entry");
  assert.equal(entry.automaticEligibility, true);

  // And it dispatches with an empty model so the provider picks its own.
  const attempts = buildRankedAttempts([{ provider: "codex", model: PROVIDER_DEFAULT_MODEL_ID, excluded: false, score: 1 }], cfg);
  assert.equal(attempts[0].config.model, "");
  assert.equal(attempts[0].providerDefault, true);
  assert.equal(attempts[0].registryModel, PROVIDER_DEFAULT_MODEL_ID);
});

// ---------------------------------------------------------------- P0-5

test("12. embedding models are excluded from chat routing", () => {
  assert.equal(classifyChatCapability({ modelId: "text-embedding-3-large" }), "unsupported");
  assert.equal(classifyChatCapability({ modelId: "bge-reranker-v2" }), "unsupported");
  assert.equal(classifyChatCapability({ modelId: "whisper-large-v3" }), "unsupported");
  assert.equal(classifyChatCapability({ modelId: "gpt-5.4" }), "unknown", "a chat model is never positively 'unsupported'");
});

test("13. jina-embeddings-v5-text-small-retrieval cannot enter the chat registry", () => {
  const cfg = { routing: { taskRoutes: {} }, providers: { lmstudio: { enabled: true, type: "http", model: "", models: [] } } };
  const catalog = catalogWith({
    lmstudio: [
      { ...validated("jina-embeddings-v5-text-small-retrieval"), state: "exposed" },
      { ...validated("google/gemma-4-26b-a4b-qat"), state: "exposed" }
    ]
  });
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.ok(!registry.some((e) => e.model === "jina-embeddings-v5-text-small-retrieval"));
  assert.ok(registry.some((e) => e.model === "google/gemma-4-26b-a4b-qat"));
});

test("14. text-embedding-nomic-embed-text-v1.5 cannot enter the chat registry", () => {
  const cfg = { routing: { taskRoutes: {} }, providers: { lmstudio: { enabled: true, type: "http", model: "", models: [] } } };
  const catalog = catalogWith({ lmstudio: [{ ...validated("text-embedding-nomic-embed-text-v1.5"), state: "exposed" }] });
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.equal(registry.length, 0);
});

test("12b. the capability classifier does not over-match a legitimate chat model", () => {
  for (const id of [
    "claude-opus-5",
    "gpt-5.4",
    "gemini-3.1-pro-high",
    "composer-2.5",
    "google/gemma-4-26b-a4b-qat",
    "liquid/lfm2-24b-a2b",
    "gpt-oss-120b-medium"
  ]) {
    assert.notEqual(classifyChatCapability({ modelId: id }), "unsupported", `${id} must not be filtered out`);
  }
});

// ---------------------------------------------------------------- P0-8

test("22. every generated attempt exists in the eligible registry", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const route = selectRoute({ config: cfg, statuses: {}, taskProfile: { taskType: "code", estimatedInputTokens: 100 }, catalog });
  const attempts = buildRankedAttempts(route.ranking, cfg);
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.ok(attempts.length);
  assert.deepEqual(verifyAttemptsAgainstRegistry(attempts, registry, cfg), []);
});

test("22b. verifyAttemptsAgainstRegistry flags an attempt that is not a current registry row", () => {
  const cfg = config();
  const registry = buildModelRegistry(cfg, {}, catalogWith({ claude: [validated("claude-opus-5")] }));
  const smuggled = [{ name: "claude", registryModel: "claude-ghost-model", config: { ...cfg.providers.claude, model: "claude-ghost-model" } }];
  const violations = verifyAttemptsAgainstRegistry(smuggled, registry, cfg);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /not a currently eligible registry entry/);
});

test("23. no attempt silently substitutes providerConfig.model when the candidate has no model", () => {
  const cfg = config();
  const attempts = buildRankedAttempts([{ provider: "claude", model: "", excluded: false, score: 5 }], cfg);
  assert.deepEqual(attempts, [], "an unresolved candidate must be dropped, not backfilled from config");
});

test("23b. a pending_assessment registry row can never become an attempt", () => {
  const cfg = config();
  const registry = buildModelRegistry(cfg, {}, defaultCatalog());
  const ranking = registry.map((e) => ({ provider: e.provider, model: e.model, excluded: false, score: 1 }));
  assert.deepEqual(buildRankedAttempts(ranking, cfg), []);
});

// ---------------------------------------------------------------- P0-9 / hygiene

test("25. no SmartRoute files or references exist in shipped source", async () => {
  const { readdirSync, statSync, readFileSync } = await import("node:fs");
  const { join, resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const selfPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(selfPath), "..");

  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "data") continue;
      const full = join(dir, name);
      // This file necessarily contains the pattern it searches for.
      if (full === selfPath) continue;
      if (statSync(full).isDirectory()) {
        if (/smart[-_]?route/i.test(name)) offenders.push(`${full} (directory)`);
        walk(full);
        continue;
      }
      if (!/\.(js|json|html|css)$/.test(name)) continue;
      if (/smart[-_]?route/i.test(name)) offenders.push(`${full} (filename)`);
      if (/smart[-_]?route/i.test(readFileSync(full, "utf8"))) offenders.push(`${full} (content)`);
    }
  };
  for (const dir of ["src", "test", "public"]) {
    walk(join(repoRoot, dir));
  }
  assert.deepEqual(offenders, [], `SmartRoute must stay removed; found: ${offenders.join(", ")}`);
});
