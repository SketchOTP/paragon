import assert from "node:assert/strict";
import test from "node:test";

import { selectRoute, buildRankedAttempts, rankRegistryByTask, scoringMethodology, TASK_TYPES } from "../src/routing/router.js";
import { buildModelRegistry } from "../src/routing/modelRegistry.js";
import { resetForTests } from "../src/orchestration/liveEnforcement.js";
import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";

test.beforeEach(() => {
  resetForTests();
});

function config(overrides = {}) {
  return {
    routing: { taskRoutes: {}, defaultProvider: "claude" },
    providers: {
      claude: {
        enabled: true,
        model: "claude-opus-5",
        models: [
          { id: "claude-opus-5", name: "Opus 5" },
          { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" }
        ]
      },
      codex: {
        enabled: true,
        model: "gpt-5.4",
        models: [{ id: "gpt-5.4", name: "GPT-5.4" }]
      },
      antigravity: {
        enabled: true,
        model: "gemini-3.1-pro-high",
        models: [{ id: "gemini-3.1-pro-high", name: "gemini-3.1-pro-high" }]
      },
      ...overrides
    }
  };
}

/**
 * PARAGON-D-004C1 (P0-4): the registry no longer trusts
 * providerConfig.models, so a routing test must supply a catalog that has
 * actually assessed the providers under test. catalogFor() marks each
 * configured model `validated` — the state a real bounded probe produces.
 * `sr()` fills that in automatically so each test only names a catalog when
 * it is specifically asserting catalog behavior.
 */
function catalogFor(cfg, { states = {} } = {}) {
  const catalog = defaultCatalog();
  for (const [provider, providerConfig] of Object.entries(cfg.providers ?? {})) {
    const entries = (providerConfig.models ?? []).map((m) => ({
      modelId: m.id,
      displayName: m.name ?? m.id,
      state: states[`${provider}/${m.id}`] ?? "validated",
      discoverySource: "documented_candidate"
    }));
    if (entries.length) {
      replaceProviderModels(catalog, provider, entries);
    }
  }
  return catalog;
}

function sr(args) {
  const catalog = args.catalog ?? catalogFor(args.config);
  return selectRoute({ ...args, catalog });
}

test("selectRoute can pick antigravity automatically when it scores best (auto-approve tool execution is now a uniform policy, not an antigravity-only exclusion)", () => {
  const cfg = config();
  cfg.routing.taskRoutes = { code: "antigravity" };
  const route = sr({
    config: cfg,
    statuses: { antigravity: { ok: true } },
    taskProfile: { taskType: "code", estimatedInputTokens: 100 }
  });
  assert.equal(route.provider, "antigravity");
});

test("selectRoute honors an explicit forceProvider/forceModel hint, including forcing antigravity", () => {
  const route = sr({
    config: config(),
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    hints: { forceProvider: "antigravity", forceModel: "gemini-3.1-pro-high" }
  });
  assert.equal(route.provider, "antigravity");
  assert.equal(route.model, "gemini-3.1-pro-high");
  assert.equal(route.reasonCode, "hint.forceProvider");
});

test("selectRoute excludes an unhealthy provider", () => {
  const route = sr({
    config: config(),
    statuses: { claude: { ok: false }, codex: { ok: true } },
    taskProfile: { taskType: "code", estimatedInputTokens: 100 }
  });
  assert.notEqual(route.provider, "claude");
});

test("selectRoute excludes a candidate whose context window is smaller than the estimated request", () => {
  const route = sr({
    config: config(),
    statuses: {},
    // codex/antigravity have unknown (null) context windows so aren't excluded by this;
    // claude's models are tagged 200000 — request bigger than that must exclude claude entries.
    taskProfile: { taskType: "code", estimatedInputTokens: 250000 }
  });
  const claudeCandidate = route.ranking.find((c) => c.provider === "claude");
  assert.equal(claudeCandidate.excluded, true);
  assert.equal(claudeCandidate.reasonCode, "eligibility.contextWindowExceeded");
});

test("selectRoute respects maxCostClass hint", () => {
  const route = sr({
    config: config(),
    statuses: {},
    taskProfile: { taskType: "quick", estimatedInputTokens: 100 },
    hints: { maxCostClass: "economy" }
  });
  // claude-opus-5 is premium and must be excluded from the ranking entirely by the cost ceiling filter
  assert.ok(!route.ranking.some((c) => c.model === "claude-opus-5"));
});

test("selectRoute taskRoutes preference biases but does not force the winner over a healthier/better-fit candidate", () => {
  const cfg = config();
  cfg.routing.taskRoutes = { code: "codex" };
  const route = sr({
    config: cfg,
    statuses: { codex: { ok: false }, claude: { ok: true } },
    taskProfile: { taskType: "code", estimatedInputTokens: 100 }
  });
  // codex is unhealthy (hard-excluded) despite being the taskRoutes preference — proves this is a signal, not an override.
  assert.notEqual(route.provider, "codex");
});

test("buildRankedAttempts dedupes by provider and respects the limit", () => {
  const ranking = [
    { provider: "claude", model: "claude-opus-5", excluded: false, score: 5 },
    { provider: "claude", model: "claude-haiku-4-5-20251001", excluded: false, score: 3 },
    { provider: "codex", model: "gpt-5.4", excluded: false, score: 2 },
    { provider: "excluded-one", model: "x", excluded: true, score: null }
  ];
  const attempts = buildRankedAttempts(ranking, config());
  assert.deepEqual(
    attempts.map((a) => a.name),
    ["claude", "codex"]
  );
  assert.equal(attempts[0].config.model, "claude-opus-5", "first (highest-scored) model for a provider wins");
});

test("selectRoute returns null when nothing is eligible", () => {
  const cfg = config();
  for (const p of Object.values(cfg.providers)) {
    p.enabled = false;
  }
  const route = sr({ config: cfg, statuses: {}, taskProfile: { taskType: "code", estimatedInputTokens: 100 } });
  assert.equal(route, null);
});

// PARAGON-D-004C: selectRoute must never route to a model the catalog has
// assessed and rejected/retired, even if it's still sitting in
// providerConfig.models.
test("selectRoute excludes a model the catalog has rejected, routing to the next eligible candidate instead", () => {
  const cfg = config();
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-opus-5", displayName: "Opus 5", state: "rejected", discoverySource: "documented_candidate" },
    { modelId: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", state: "validated", discoverySource: "documented_candidate" }
  ]);
  const route = sr({
    config: cfg,
    statuses: {},
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    catalog
  });
  assert.ok(route);
  assert.notEqual(route.model, "claude-opus-5", "a catalog-rejected model must never be the live routing decision");
  assert.ok(
    !route.ranking.some((r) => r.model === "claude-opus-5"),
    "the ranking algorithm must not even list a catalog-rejected model, not merely exclude it with a reason"
  );
});

test("rankRegistryByTask's ranking algorithm only ever considers models the catalog exposes/validates — an unvalidated or rejected model never appears, ranked or excluded", () => {
  const cfg = config();
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" },
    { modelId: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", state: "unknown", discoverySource: "documented_candidate" }
  ]);
  const registry = buildModelRegistry(cfg, {}, catalog);
  const ranked = rankRegistryByTask(registry, cfg.routing.taskRoutes);
  for (const taskType of Object.keys(ranked)) {
    assert.ok(
      !ranked[taskType].some((r) => r.model === "claude-haiku-4-5-20251001"),
      `${taskType} ranking must not list the unvalidated model at all`
    );
  }
});

test("rankRegistryByTask produces a 1-10 scale (1=best) per task type; antigravity now ranks like any other provider, and an unhealthy provider is excluded with a reason instead of a rank", () => {
  const cfg = config();
  cfg.providers.antigravity.enabled = true;
  const registry = buildModelRegistry(cfg, { claude: { ok: true }, codex: { ok: false }, antigravity: { ok: true } }, catalogFor(cfg));
  const ranking = rankRegistryByTask(registry, cfg.routing.taskRoutes);

  for (const taskType of TASK_TYPES) {
    assert.ok(ranking[taskType], `missing ranking for task type ${taskType}`);
  }

  const codeRanking = ranking.code;
  const antigravityEntry = codeRanking.find((e) => e.provider === "antigravity");
  assert.equal(antigravityEntry.excluded, false, "antigravity must be able to get a rank now that auto-approve is a uniform policy");
  assert.ok(antigravityEntry.tenScale >= 1 && antigravityEntry.tenScale <= 10);

  const codexEntry = codeRanking.find((e) => e.provider === "codex");
  assert.equal(codexEntry.excluded, true, "an unhealthy provider must still be excluded with a reason instead of a rank");
  assert.equal(codexEntry.reasonCode, "eligibility.unhealthyProvider");
  assert.equal(codexEntry.rank, undefined);

  const eligible = codeRanking.filter((e) => !e.excluded);
  for (const entry of eligible) {
    assert.ok(entry.tenScale >= 1 && entry.tenScale <= 10);
  }
  // Best (rank 1) must have the lowest tenScale among eligible entries.
  const best = eligible.find((e) => e.rank === 1);
  assert.ok(eligible.every((e) => e.tenScale >= best.tenScale));
});

test("rankRegistryByTask orders by score descending, rank 1 = highest score", () => {
  const cfg = config();
  const registry = buildModelRegistry(cfg, { claude: { ok: true }, codex: { ok: true } }, catalogFor(cfg));
  const ranking = rankRegistryByTask(registry, cfg.routing.taskRoutes).code;
  const eligible = ranking.filter((e) => !e.excluded).sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < eligible.length; i += 1) {
    assert.ok(eligible[i - 1].score >= eligible[i].score, "rank order must follow score order");
  }
});

test("selectRoute picks the cheaper 'good enough' model over a pricier higher-index one when benchmark data is available", () => {
  const cfg = config();
  cfg.providers.claude.models = [{ id: "premium-model", name: "premium-model" }];
  cfg.providers.codex.models = [{ id: "cheap-model", name: "cheap-model" }];
  cfg.providers.claude.model = "premium-model";
  cfg.providers.codex.model = "cheap-model";
  delete cfg.providers.antigravity;

  const benchmarkRows = [
    { source: "artificial-analysis", model_permaslug: "premium-model", intelligence_index: 90, pricing: { prompt: "0.00006" } },
    { source: "artificial-analysis", model_permaslug: "cheap-model", intelligence_index: 80, pricing: { prompt: "0.000005" } }
  ];

  const route = sr({
    config: cfg,
    statuses: { claude: { ok: true }, codex: { ok: true } },
    taskProfile: { taskType: "plan", estimatedInputTokens: 100 },
    benchmarkRows
  });

  assert.equal(route.provider, "codex", "the cheaper model within the good-enough floor must win, not the pricier higher-scoring one");
  const winnerReasons = route.ranking.find((c) => c.provider === "codex").reasons;
  assert.ok(winnerReasons.some((r) => r.includes("good enough")), "the win must be explainable — reasons must cite the value scoring");
});

test("selectRoute does not let a below-floor cheap model beat a good-enough pricier one", () => {
  const cfg = config();
  cfg.providers.claude.models = [{ id: "best-model", name: "best-model" }];
  cfg.providers.codex.models = [{ id: "good-enough-model", name: "good-enough-model" }];
  cfg.providers.antigravity.models = [{ id: "too-weak-model", name: "too-weak-model" }];
  cfg.providers.antigravity.enabled = false; // disabled purely to keep this test's candidate pool to the three models under test
  cfg.providers.claude.model = "best-model";
  cfg.providers.codex.model = "good-enough-model";
  cfg.providers.cursor = {
    enabled: true,
    model: "too-weak-model",
    models: [{ id: "too-weak-model", name: "too-weak-model" }]
  };

  const benchmarkRows = [
    { source: "artificial-analysis", model_permaslug: "best-model", intelligence_index: 90, pricing: { prompt: "0.00008" } },
    { source: "artificial-analysis", model_permaslug: "good-enough-model", intelligence_index: 80, pricing: { prompt: "0.00003" } },
    { source: "artificial-analysis", model_permaslug: "too-weak-model", intelligence_index: 30, pricing: { prompt: "0.000001" } }
  ];

  const route = sr({
    config: cfg,
    statuses: { claude: { ok: true }, codex: { ok: true }, cursor: { ok: true } },
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    benchmarkRows
  });

  assert.equal(route.provider, "codex", "cheapest-overall-but-below-quality-floor must lose to a pricier-but-good-enough candidate");
});

test("selectRoute leaves candidates with no matched benchmark scored purely on the internal formula", () => {
  const cfg = config();
  const route = sr({
    config: cfg,
    statuses: { claude: { ok: true }, codex: { ok: true } },
    taskProfile: { taskType: "code", estimatedInputTokens: 100 },
    benchmarkRows: [{ source: "artificial-analysis", model_permaslug: "totally-unrelated-model-xyz", intelligence_index: 99, pricing: { prompt: "0.000001" } }]
  });
  assert.ok(route, "must still produce a route when no registry entry matches the benchmark data");
  for (const candidate of route.ranking) {
    assert.ok(!candidate.reasons?.some((r) => r.includes("good enough") || r.includes("quality floor")), "no candidate should have value-scoring reasons applied when nothing matched");
  }
});

test("scoringMethodology exposes the real live weights, cost preference, and value-scoring floor ratio", () => {
  const methodology = scoringMethodology();
  assert.equal(methodology.kind, "internal-deterministic-plus-value");
  assert.ok(methodology.weights.taskRoutePreference);
  assert.ok(methodology.weights.valueBonusMax);
  assert.ok(methodology.taskCostPreference.plan);
  assert.ok(methodology.qualityFloorRatio > 0 && methodology.qualityFloorRatio < 1);
  assert.match(methodology.description, /good enough/i);
});
