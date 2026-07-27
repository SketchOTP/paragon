import assert from "node:assert/strict";
import test from "node:test";
import { enforceBalancedSafety } from "../src/smartRoute/balancedSafety.js";

const registry = [
  {
    id: "codex:default",
    provider: "codex",
    tier: "mid",
    routing: { priority: 60 }
  },
  {
    id: "claude:default",
    provider: "claude",
    tier: "premium",
    routing: { priority: 70 }
  },
  {
    id: "antigravity:flash",
    provider: "antigravity",
    tier: "cheap",
    routing: { priority: 40 }
  }
];

const config = {
  routing: {
    defaultProvider: "cursor",
    taskRoutes: { plan: "claude", debug: "claude", ask: "antigravity" }
  }
};

test("enforceBalancedSafety upgrades architecture away from mid tier", () => {
  const decision = { task_type: "architecture", complexity: 4, risk: 3 };
  const selected = registry[0];
  const result = enforceBalancedSafety(selected, registry, decision, config, registry, {
    mode: "balanced"
  });
  assert.equal(result.selected.provider, "claude");
  assert.equal(result.adjusted, true);
  assert.ok(result.reasons.includes("premium_minimum"));
});

test("enforceBalancedSafety no-op in shadow_test mode", () => {
  const decision = { task_type: "architecture", complexity: 4, risk: 4 };
  const selected = registry[0];
  const result = enforceBalancedSafety(selected, registry, decision, config, registry, {
    mode: "shadow_test"
  });
  assert.equal(result.selected.provider, "codex");
  assert.equal(result.adjusted, false);
});

test("enforceBalancedSafety enforces legacy tier floor for hard tasks", () => {
  const decision = { task_type: "research", complexity: 4, risk: 2 };
  const selected = registry[2];
  const result = enforceBalancedSafety(selected, registry, decision, config, registry, {
    mode: "balanced"
  });
  assert.equal(result.selected.tier, "premium");
  assert.ok(result.reasons.includes("hard_task_legacy_tier_floor"));
});
