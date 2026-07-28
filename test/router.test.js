import assert from "node:assert/strict";
import test from "node:test";

import { selectRoute, buildRankedAttempts, rankRegistryByTask, scoringMethodology, TASK_TYPES } from "../src/routing/router.js";
import { buildModelRegistry } from "../src/routing/modelRegistry.js";
import { resetForTests } from "../src/orchestration/liveEnforcement.js";

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

test("selectRoute never picks antigravity automatically, even if scored highest", () => {
  // Bias everything toward antigravity via taskRoutes preference — should
  // still be excluded, proving automaticEligibility is a hard gate, not a
  // scoring penalty that a strong enough signal could overcome.
  const cfg = config();
  cfg.routing.taskRoutes = { code: "antigravity" };
  const route = selectRoute({ config: cfg, statuses: {}, taskProfile: { taskType: "code", estimatedInputTokens: 100 } });
  assert.notEqual(route.provider, "antigravity");
});

test("selectRoute honors an explicit forceProvider/forceModel hint, including forcing antigravity", () => {
  const route = selectRoute({
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
  const route = selectRoute({
    config: config(),
    statuses: { claude: { ok: false }, codex: { ok: true } },
    taskProfile: { taskType: "code", estimatedInputTokens: 100 }
  });
  assert.notEqual(route.provider, "claude");
});

test("selectRoute excludes a candidate whose context window is smaller than the estimated request", () => {
  const route = selectRoute({
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
  const route = selectRoute({
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
  const route = selectRoute({
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
  const route = selectRoute({ config: cfg, statuses: {}, taskProfile: { taskType: "code", estimatedInputTokens: 100 } });
  assert.equal(route, null);
});

test("rankRegistryByTask produces a 1-10 scale (1=best) per task type, excluded entries carry a reason instead of a rank", () => {
  const cfg = config();
  cfg.providers.antigravity.enabled = true;
  const registry = buildModelRegistry(cfg, { claude: { ok: true }, codex: { ok: true }, antigravity: { ok: true } });
  const ranking = rankRegistryByTask(registry, cfg.routing.taskRoutes);

  for (const taskType of TASK_TYPES) {
    assert.ok(ranking[taskType], `missing ranking for task type ${taskType}`);
  }

  const codeRanking = ranking.code;
  const antigravityEntry = codeRanking.find((e) => e.provider === "antigravity");
  assert.equal(antigravityEntry.excluded, true, "antigravity must never get a rank via automatic routing");
  assert.equal(antigravityEntry.reasonCode, "eligibility.automaticEligibilityDisabled");
  assert.equal(antigravityEntry.rank, undefined);

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
  const registry = buildModelRegistry(cfg, { claude: { ok: true }, codex: { ok: true } });
  const ranking = rankRegistryByTask(registry, cfg.routing.taskRoutes).code;
  const eligible = ranking.filter((e) => !e.excluded).sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < eligible.length; i += 1) {
    assert.ok(eligible[i - 1].score >= eligible[i].score, "rank order must follow score order");
  }
});

test("scoringMethodology exposes the real live weights and cost preference, not a static description that could drift", () => {
  const methodology = scoringMethodology();
  assert.equal(methodology.kind, "internal-deterministic");
  assert.ok(methodology.weights.taskRoutePreference);
  assert.ok(methodology.taskCostPreference.plan);
  assert.match(methodology.description, /not an external benchmark/i);
});
