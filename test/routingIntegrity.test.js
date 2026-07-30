/**
 * PARAGON routing-integrity regressions.
 *
 * These are the invariants that must survive every routing change, originally
 * pinned for PARAGON-D-004C1 and re-pinned here against the single production
 * engine (PARAGON-D-004E). Each test names the defect it guards so a future
 * change that reintroduces a bypass fails here with an explanation rather than
 * a bare assertion diff. HTTP-level coverage of the same contract lives in
 * routingIntegrity.api.test.js.
 *
 * Directive requirement 15: the new router preserves all of these gates.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { selectAutomaticRoute, verifyPlanAgainstCandidates } from "../src/routing/automaticRouting.js";
import { buildAttemptPlan } from "../src/routing/attemptPlan.js";
import { buildModelRegistry } from "../src/routing/modelRegistry.js";
import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";
import { classifyChatCapability, PROVIDER_DEFAULT_MODEL_ID } from "../src/modelCapability.js";
import { resetForTests } from "../src/orchestration/liveEnforcement.js";
import { createQuotaStateStore } from "../src/routing/quotaState.js";

test.beforeEach(() => {
  resetForTests();
});

function config(overrides = {}) {
  return {
    routing: { priority: "balanced" },
    providers: {
      claude: { enabled: true, models: [{ id: "claude-opus-5", name: "Opus 5" }] },
      codex: { enabled: true, models: [{ id: "gpt-5.4", name: "GPT-5.4" }] },
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

/** Minimal but complete request profile — the engine reads every dimension. */
function profile(overrides = {}) {
  return {
    workType: "code",
    complexity: "normal",
    risk: "normal",
    reasoningDemand: "medium",
    contextBand: "small",
    outputContract: "code",
    requiredCapabilities: ["chatCompletions"],
    latencyPreference: "normal",
    qualityPreference: "balanced",
    costSensitivity: "normal",
    estimatedInputTokens: 100,
    ...overrides
  };
}

function route(cfg, catalog, { hints = {}, taskProfile = {}, statuses = {}, quotaState = null, priority } = {}) {
  return selectAutomaticRoute({
    config: cfg,
    statuses,
    catalog,
    telemetryStore: { entries: {} },
    benchmarkRows: [],
    taskProfile: profile(taskProfile),
    hints,
    settings: {},
    quotaState,
    priority
  });
}

// ------------------------------------------------- no static fallback exists

test("1. no static fallback exists when the eligible set is empty — no winner rather than a config-derived route", () => {
  const cfg = config();
  // Providers configured and enabled, but the catalog rejected everything.
  const catalog = catalogWith({
    claude: [{ ...validated("claude-opus-5"), state: "rejected" }],
    codex: [{ ...validated("gpt-5.4"), state: "rejected" }]
  });
  const result = route(cfg, catalog);
  assert.equal(result.winner, null, "an empty eligible set must not be papered over with a configured fallback");
  assert.deepEqual(result.attemptPlan, []);
});

test("1b. no independent config-derived dispatch path is exported", async () => {
  const providerFallback = await import("../src/providerFallback.js");
  assert.equal(providerFallback.buildProviderAttempts, undefined);
});

test("1c. the removed legacy routing fields cannot influence a decision because the schema has no place for them", async () => {
  const { defaultConfig } = await import("../src/defaultConfig.js");
  assert.equal(defaultConfig.routing.defaultProvider, undefined);
  assert.equal(defaultConfig.routing.fallbackChain, undefined);
  assert.equal(defaultConfig.routing.taskRoutes, undefined);
  for (const [name, providerConfig] of Object.entries(defaultConfig.providers)) {
    assert.equal(providerConfig.model, undefined, `providers.${name}.model must not exist`);
  }
});

// ------------------------------------------------- forced routes only narrow

test("2. a rejected model cannot be selected", () => {
  const cfg = config();
  const catalog = catalogWith({
    claude: [{ ...validated("claude-opus-5"), state: "rejected" }],
    codex: [validated("gpt-5.4")]
  });
  const result = route(cfg, catalog);
  assert.equal(result.winner.provider, "codex");
  assert.equal(result.winner.providerModelId, "gpt-5.4");
});

test("5. a forced rejected model is denied, never dispatched", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [{ ...validated("claude-opus-5"), state: "rejected" }], codex: [validated("gpt-5.4")] });
  const result = route(cfg, catalog, { hints: { forceProvider: "claude", forceModel: "claude-opus-5" } });
  assert.equal(result.rejected, true);
  assert.equal(result.reasonCode, "routing.forcedModelNotEligible");
});

test("5b. a forced model that exists nowhere in the catalog is denied", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] });
  const result = route(cfg, catalog, { hints: { forceProvider: "claude", forceModel: "totally-made-up" } });
  assert.equal(result.rejected, true);
  assert.equal(result.reasonCode, "routing.forcedModelNotEligible");
});

test("6. a forced provider with no eligible model is denied", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [{ ...validated("claude-opus-5"), state: "unknown" }], codex: [validated("gpt-5.4")] });
  const result = route(cfg, catalog, { hints: { forceProvider: "claude" } });
  assert.equal(result.rejected, true);
  assert.equal(result.reasonCode, "routing.forcedProviderNotEligible");
});

test("6b. a forced provider that is disabled is denied", () => {
  const cfg = config();
  cfg.providers.claude.enabled = false;
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const result = route(cfg, catalog, { hints: { forceProvider: "claude" } });
  assert.equal(result.rejected, true);
  assert.equal(result.reasonCode, "routing.forcedProviderNotEligible");
});

test("7. forced routing still obeys the caller's max cost class", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] }); // opus -> premium
  const result = route(cfg, catalog, {
    taskProfile: { workType: "quick" },
    hints: { forceProvider: "claude", forceModel: "claude-opus-5", maxCostClass: "economy" }
  });
  assert.equal(result.rejected, true, "the cost ceiling was previously bypassed entirely by forcing");
});

test("8. forced routing still obeys context limits", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] });
  const result = route(cfg, catalog, {
    taskProfile: { estimatedInputTokens: 5_000_000, contextBand: "huge" },
    hints: { forceProvider: "claude", forceModel: "claude-opus-5" }
  });
  assert.equal(result.rejected, true);
  assert.match(result.message, /eligibility gate/);
});

test("8b. forced routing still obeys provider health", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] });
  const result = route(cfg, catalog, { statuses: { claude: { ok: false } }, hints: { forceProvider: "claude" } });
  assert.equal(result.rejected, true);
});

test("8c. forced routing cannot bypass an observed usage limit", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const quotaState = createQuotaStateStore();
  quotaState.recordQuotaFailure("claude", { classification: "QUOTA_EXHAUSTED", detail: "usage limit reached" });
  const result = route(cfg, catalog, { hints: { forceProvider: "claude" }, quotaState });
  assert.equal(result.rejected, true, "an exhausted allowance is a hard gate, not a scoring penalty");
});

test("a forced route that passes every gate is honored and reports hint.forceProvider", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const result = route(cfg, catalog, { hints: { forceProvider: "claude", forceModel: "claude-opus-5" } });
  assert.equal(result.rejected, undefined);
  assert.equal(result.winner.provider, "claude");
  assert.equal(result.winner.providerModelId, "claude-opus-5");
  assert.equal(result.reasonCode, "hint.forceProvider");
  assert.equal(result.confidence.level, "explicit_validated");
});

// ------------------------------------------------- unassessed providers

test("9. an unassessed provider contributes zero eligible models", () => {
  const cfg = config();
  const registry = buildModelRegistry(cfg, {}, defaultCatalog());
  assert.equal(registry.filter((e) => e.automaticEligibility).length, 0);
  assert.ok(registry.every((e) => e.pendingAssessment));
});

test("9b. an unassessed provider is not routable by the live engine either", () => {
  const cfg = config();
  const result = route(cfg, defaultCatalog());
  assert.equal(result.winner, null);
  assert.ok(
    result.ranked.every((c) => c.excluded),
    "every candidate from an unassessed provider must be excluded, not merely deprioritized"
  );
});

test("10. a failed refresh for an unassessed provider does not restore config trust", () => {
  // A failed refresh never creates a bucket (refreshProviderCatalog throws
  // before replaceProviderModels), so the provider stays bucket-less.
  const cfg = config({
    lmstudio: {
      enabled: true,
      type: "http",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: [{ id: "google/gemma-4-26b-a4b-qat", name: "gemma" }]
    }
  });
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.equal(registry.filter((e) => e.provider === "lmstudio" && e.automaticEligibility).length, 0);
  assert.equal(registry.find((e) => e.provider === "lmstudio").modelState, "pending_assessment");
});

test("11. provider-default routing requires an explicitly validated provider-default entry", () => {
  const cfg = { routing: { priority: "balanced" }, providers: { codex: { enabled: true, models: [] } } };

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
  const plan = buildAttemptPlan([{ provider: "codex", providerModelId: PROVIDER_DEFAULT_MODEL_ID, excluded: false }], cfg);
  assert.equal(plan[0].config.model, "");
  assert.equal(plan[0].providerDefault, true);
  assert.equal(plan[0].registryModel, PROVIDER_DEFAULT_MODEL_ID);
});

// ------------------------------------------------- non-chat models

test("12. embedding models are excluded from chat routing", () => {
  assert.equal(classifyChatCapability({ modelId: "text-embedding-3-large" }), "unsupported");
  assert.equal(classifyChatCapability({ modelId: "bge-reranker-v2" }), "unsupported");
  assert.equal(classifyChatCapability({ modelId: "whisper-large-v3" }), "unsupported");
  assert.equal(classifyChatCapability({ modelId: "gpt-5.4" }), "unknown", "a chat model is never positively 'unsupported'");
});

test("13. jina-embeddings-v5-text-small-retrieval cannot enter the chat registry", () => {
  const cfg = { routing: { priority: "balanced" }, providers: { lmstudio: { enabled: true, type: "http", models: [] } } };
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
  const cfg = { routing: { priority: "balanced" }, providers: { lmstudio: { enabled: true, type: "http", models: [] } } };
  const catalog = catalogWith({ lmstudio: [{ ...validated("text-embedding-nomic-embed-text-v1.5"), state: "exposed" }] });
  const registry = buildModelRegistry(cfg, {}, catalog);
  assert.equal(registry.length, 0);
});

test("14b. a non-chat model cannot become a candidate for the live engine", () => {
  const cfg = { routing: { priority: "balanced" }, providers: { lmstudio: { enabled: true, type: "http", models: [] } } };
  const catalog = catalogWith({
    lmstudio: [
      { ...validated("text-embedding-3-large"), state: "exposed" },
      { ...validated("google/gemma-4-26b-a4b-qat"), state: "exposed" }
    ]
  });
  const result = route(cfg, catalog);
  assert.ok(!result.ranked.some((c) => c.providerModelId === "text-embedding-3-large"));
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

// ------------------------------------------------- every attempt is verified

test("22. every generated attempt maps to an eligible candidate from the same computation", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")], codex: [validated("gpt-5.4")] });
  const result = route(cfg, catalog);
  assert.ok(result.attemptPlan.length);
  assert.deepEqual(verifyPlanAgainstCandidates(result.attemptPlan, result.ranked, cfg), []);
});

test("22b. verification flags an attempt that is not a currently eligible candidate", () => {
  const cfg = config();
  const catalog = catalogWith({ claude: [validated("claude-opus-5")] });
  const result = route(cfg, catalog);
  const smuggled = [
    { name: "claude", registryModel: "claude-ghost-model", config: { ...cfg.providers.claude, model: "claude-ghost-model" } }
  ];
  const violations = verifyPlanAgainstCandidates(smuggled, result.ranked, cfg);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /not a currently eligible registry entry/);
});

test("23. no attempt is created for a candidate with no resolved model", () => {
  const cfg = config();
  const plan = buildAttemptPlan([{ provider: "claude", providerModelId: "", excluded: false }], cfg);
  assert.deepEqual(plan, [], "an unresolved candidate must be dropped, not backfilled from config");
});

test("23b. an excluded candidate can never become an attempt", () => {
  const cfg = config();
  const plan = buildAttemptPlan(
    [{ provider: "claude", providerModelId: "claude-opus-5", excluded: true, reasonCode: "eligibility.unhealthyProvider" }],
    cfg
  );
  assert.deepEqual(plan, []);
});

test("23c. a disabled provider can never become an attempt", () => {
  const cfg = config();
  cfg.providers.claude.enabled = false;
  const plan = buildAttemptPlan([{ provider: "claude", providerModelId: "claude-opus-5", excluded: false }], cfg);
  assert.deepEqual(plan, []);
});

// ------------------------------------------------- hygiene

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
