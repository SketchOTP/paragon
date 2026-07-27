import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCanaryEligibility,
  inCanaryPercent,
  resolveRoutingProvider,
  checkCanaryRollback,
  clearCanaryRollback,
  mergeCanaryConfig,
  isCanaryMode
} from "../src/smartRoute/canary.js";
import { aggregateCanaryStats, buildShadowReport } from "../src/smartRoute/shadowReport.js";
import { defaultConfig } from "../src/defaultConfig.js";
import { writeCurrentSnapshot } from "../src/smartRoute/modelSnapshotStore.js";
import { withIsolatedDataDir } from "./helpers/isolatedDataDir.js";


const registry = [
  { provider: "codex", tier: "mid", cost_input_per_1m: 2, cost_output_per_1m: 8 },
  { provider: "antigravity", tier: "cheap", cost_input_per_1m: 0.1, cost_output_per_1m: 0.4 },
  { provider: "claude", tier: "premium", cost_input_per_1m: 5, cost_output_per_1m: 20 }
];

function baseConfig(overrides = {}) {
  return {
    ...defaultConfig,
    providers: {
      codex: { ...defaultConfig.providers.codex, enabled: true },
      antigravity: { ...defaultConfig.providers.antigravity, enabled: true },
      claude: { ...defaultConfig.providers.claude, enabled: true }
    },
    routing: {
      ...defaultConfig.routing,
      smartRoute: {
        ...defaultConfig.routing.smartRoute,
        mode: "canary",
        ...overrides.smartRoute
      }
    }
  };
}

function smartDecision(overrides = {}) {
  return {
    provider: "antigravity",
    tier: "cheap",
    task_type: "chat",
    complexity: 2,
    risk: 1,
    router_confidence: 0.9,
    classifier: { task_type: "chat", complexity: 2, risk: 1, confidence: 0.9 },
    features: {},
    ...overrides
  };
}

async function withValidSnapshot(run) {
  await withIsolatedDataDir(async () => {
    await writeCurrentSnapshot({
      version: 1,
      stale: false,
      refresh_status: "ok",
      models: [
        { canonical_id: "antigravity:default", provider: "antigravity", model: "default", available: true },
        { canonical_id: "codex:default", provider: "codex", model: "default", available: true }
      ],
      rankings: {
        chat: [{ canonical_id: "antigravity:default", rank: 1, provider: "antigravity" }],
        summarize: [{ canonical_id: "antigravity:default", rank: 1, provider: "antigravity" }]
      }
    });
    await run();
  });
}

test("isCanaryMode detects canary routing mode", () => {
  assert.equal(isCanaryMode(baseConfig()), true);
  assert.equal(isCanaryMode(baseConfig({ smartRoute: { mode: "shadow_test" } })), false);
});

test("canary disabled blocks eligibility", () => {
  const config = baseConfig({
    smartRoute: { canary: { enabled: false } }
  });
  const result = evaluateCanaryEligibility(smartDecision(), "codex", config, registry);
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("canary_disabled"));
});

test("canary blocked by task type", () => {
  const result = evaluateCanaryEligibility(
    smartDecision({ task_type: "architecture", classifier: { task_type: "architecture" } }),
    "claude",
    baseConfig(),
    registry
  );
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("task_type_not_allowed"));
});

test("canary blocked by complexity", () => {
  const result = evaluateCanaryEligibility(
    smartDecision({ complexity: 5, classifier: { complexity: 5, task_type: "chat" } }),
    "codex",
    baseConfig(),
    registry
  );
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("complexity_too_high"));
});

test("canary blocked by risk", () => {
  const result = evaluateCanaryEligibility(
    smartDecision({ risk: 4, classifier: { risk: 4, task_type: "chat" } }),
    "codex",
    baseConfig(),
    registry
  );
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("risk_too_high"));
});

test("canary blocked by low confidence", () => {
  const result = evaluateCanaryEligibility(
    smartDecision({ router_confidence: 0.5, classifier: { confidence: 0.5, task_type: "chat" } }),
    "codex",
    baseConfig(),
    registry
  );
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("low_confidence"));
});

test("canary blocks danger downgrade when not allowed", () => {
  const result = evaluateCanaryEligibility(
    smartDecision({
      provider: "antigravity",
      tier: "cheap",
      task_type: "code_debug",
      complexity: 4,
      classifier: { task_type: "code_debug", complexity: 4, risk: 2 }
    }),
    "claude",
    baseConfig(),
    registry
  );
  assert.equal(result.eligible, false);
  assert.ok(
    result.blockReasons.includes("task_type_not_allowed") ||
      result.blockReasons.includes("danger_downgrade_blocked")
  );
});

test("eligible canary request executes SmartRoute with valid snapshot", async () => {
  await clearCanaryRollback();
  await withValidSnapshot(async () => {
    const config = baseConfig({ smartRoute: { canary: { percent: 100 } } });
    const result = await resolveRoutingProvider({
      smartDecision: smartDecision({ task_type: "summarize", classifier: { task_type: "summarize" } }),
      legacyProvider: "codex",
      config,
      registry,
      seed: "eligible-summarize"
    });
    assert.equal(result.canary.eligible, true);
    assert.equal(result.canary.executed, true);
    assert.equal(result.provider, "antigravity");
  });
});

test("canary without snapshot falls back to legacy", async () => {
  await withIsolatedDataDir(async () => {
    await clearCanaryRollback();
    const config = baseConfig({ smartRoute: { canary: { percent: 100 } } });
    const result = await resolveRoutingProvider({
      smartDecision: smartDecision({ task_type: "summarize", classifier: { task_type: "summarize" } }),
      legacyProvider: "codex",
      config,
      registry,
      seed: "eligible-summarize"
    });
    assert.equal(result.provider, "codex");
    assert.equal(result.canary.executed, false);
    assert.ok(result.canary.block_reasons.includes("model_intelligence_stale"));
  });
});

test("canary percent exclusion falls back to legacy", async () => {
  await clearCanaryRollback();
  const config = baseConfig({ smartRoute: { canary: { percent: 0 } } });
  const result = await resolveRoutingProvider({
    smartDecision: smartDecision(),
    legacyProvider: "codex",
    config,
    registry,
    seed: "any"
  });
  assert.equal(result.provider, "codex");
  assert.equal(result.canary.executed, false);
  assert.ok(result.canary.block_reasons.includes("canary_percent_excluded"));
});

test("rollback triggers after failure threshold", async () => {
  await clearCanaryRollback();
  const config = baseConfig({
    smartRoute: {
      canary: {
        rollback: {
          enabled: true,
          minRequests: 5,
          maxValidationFailureRate: 0.1,
          maxTimeoutRate: 1,
          maxThumbsDownRate: 1,
          maxFallbackRate: 1
        }
      }
    }
  });

  const decisions = Array.from({ length: 5 }, () => ({
    canary_executed: true,
    success: false,
    validator_result: "fail"
  }));

  const result = await checkCanaryRollback(config, decisions);
  assert.equal(result.triggered, true);
  assert.ok(result.reason.includes("validation_failure_rate"));
});

test("report includes canary stats", () => {
  const report = buildShadowReport(
    [
      {
        mode: "canary",
        canary_eligible: true,
        canary_executed: true,
        canary_blocked: false,
        legacy_provider: "codex",
        smart_provider: "antigravity",
        legacy_cost_estimate: 0.05,
        smart_cost_estimate: 0.01,
        success: true
      },
      {
        mode: "canary",
        canary_eligible: true,
        canary_executed: false,
        canary_blocked: true,
        canary_block_reasons: ["canary_percent_excluded"]
      }
    ],
    registry
  );

  assert.equal(report.canary.canary_eligible_requests, 2);
  assert.equal(report.canary.canary_executed_requests, 1);
  assert.equal(report.canary.canary_blocked_requests, 1);
  assert.ok(report.canary.canary_block_reasons.canary_percent_excluded);
});

test("inCanaryPercent is stable for same seed", () => {
  assert.equal(inCanaryPercent("stable-seed", 50), inCanaryPercent("stable-seed", 50));
});

test("mergeCanaryConfig applies defaults", () => {
  const merged = mergeCanaryConfig({ canary: { percent: 25 } });
  assert.equal(merged.percent, 25);
  assert.equal(merged.maxComplexity, 3);
  assert.equal(merged.rollback.minRequests, 25);
});
