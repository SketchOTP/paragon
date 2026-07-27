import assert from "node:assert/strict";
import test from "node:test";
import {
  activateLiveGuard,
  computeLiveRates,
  evaluateLiveGuardConditions,
  filterLiveDecisions,
  mergeLiveGuardConfig,
  triggerLiveGuardRollback
} from "../src/smartRoute/liveGuard.js";

test("mergeLiveGuardConfig applies defaults", () => {
  const guard = mergeLiveGuardConfig({});
  assert.equal(guard.enabled, true);
  assert.equal(guard.minRequests, 10);
  assert.equal(guard.maxExecutionMismatchRate, 0);
  assert.equal(guard.rollbackMode, "shadow_test");
});

test("filterLiveDecisions only keeps balanced rows since activation", () => {
  const state = { activated_at: "2026-07-04T12:00:00.000Z" };
  const rows = [
    { mode: "balanced", timestamp: "2026-07-04T11:00:00.000Z" },
    { mode: "balanced", timestamp: "2026-07-04T12:01:00.000Z" },
    { mode: "shadow_test", timestamp: "2026-07-04T12:02:00.000Z" }
  ];
  const filtered = filterLiveDecisions(rows, state);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].timestamp, "2026-07-04T12:01:00.000Z");
});

test("computeLiveRates flags mismatch null-final and premium-on-cheap", () => {
  const rows = [
    {
      success: true,
      task_type: "chat",
      complexity: 1,
      risk: 1,
      smart_tier: "cheap",
      final_executed_canonical_id: "antigravity:flash",
      execution_mismatch: false
    },
    {
      success: false,
      execution_failed: true,
      timeout: true,
      task_type: "summarize",
      complexity: 1,
      risk: 1,
      smart_tier: "cheap",
      final_executed_canonical_id: null,
      execution_mismatch: false
    },
    {
      success: true,
      task_type: "chat",
      complexity: 1,
      risk: 1,
      smart_tier: "premium",
      final_executed_canonical_id: "claude:claude-opus-4-6",
      execution_mismatch: true
    }
  ];
  const rates = computeLiveRates(rows);
  assert.equal(rates.total, 3);
  assert.equal(rates.execution_mismatch_count, 1);
  assert.equal(rates.null_final_executed_count, 1);
  assert.equal(rates.premium_on_cheap_count, 1);
  assert.ok(rates.timeout_rate > 0);
  assert.ok(rates.http_failure_rate > 0);
});

test("evaluateLiveGuardConditions trips on single execution_mismatch", async () => {
  const config = {
    routing: {
      smartRoute: {
        mode: "balanced",
        liveGuard: mergeLiveGuardConfig({})
      }
    }
  };

  const state = {
    active: true,
    rolled_back: false,
    activated_at: new Date(Date.now() - 1000).toISOString(),
    intelligence_hash: "abc",
    research_hash: "r1"
  };

  const decisions = [
    {
      mode: "balanced",
      timestamp: new Date().toISOString(),
      success: true,
      task_type: "chat",
      complexity: 1,
      risk: 1,
      smart_tier: "cheap",
      final_executed_canonical_id: "antigravity:flash",
      execution_mismatch: true
    }
  ];

  const evaluation = await evaluateLiveGuardConditions(config, decisions, {
    state,
    snapshot: {
      intelligence_hash: "abc",
      research_hash: "r1",
      models: [
        {
          canonical_id: "antigravity:flash",
          pricing: { input_per_1m: 0.1, cost_sensitive_eligible: true, pricing_status: "valid" }
        }
      ],
      stale: false,
      refresh_status: "ok",
      generated_at: new Date().toISOString()
    },
    research: { research_hash: "r1" }
  });

  assert.ok(evaluation.failures.includes("execution_mismatch"));
  assert.ok(!evaluation.failures.includes("stale_snapshot"));
});

test("triggerLiveGuardRollback writes shadow_test mode", async () => {
  const { readConfig, writeConfig } = await import("../src/configStore.js");
  const before = await readConfig();
  await writeConfig({
    ...before,
    routing: {
      ...before.routing,
      smartRoute: {
        ...before.routing?.smartRoute,
        mode: "balanced",
        liveGuard: { enabled: true, rollbackMode: "shadow_test" }
      }
    }
  });

  const config = await readConfig();
  await activateLiveGuard(config, {
    snapshot: { intelligence_hash: "h", research_hash: "r" },
    research: { research_hash: "r" }
  });

  const result = await triggerLiveGuardRollback(config, "execution_mismatch", {
    total: 1,
    execution_mismatch_count: 1
  });

  assert.equal(result.rollbackMode, "shadow_test");
  const after = await readConfig();
  assert.equal(after.routing.smartRoute.mode, "shadow_test");
});
