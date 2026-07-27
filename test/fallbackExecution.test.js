import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderError, buildProviderSwitch } from "../src/smartRoute/fallbackReasons.js";
import {
  buildSmartRouteAttempts,
  isSafeCheapTask,
  applyCheapTaskTierCeiling,
  mergeSafeCheapTasks
} from "../src/smartRoute/safeCheapTasks.js";
import { aggregateExecutionRates, buildExecutorAudit } from "../src/smartRoute/shadowReport.js";

const registry = [
  {
    id: "antigravity:flash",
    provider: "antigravity",
    tier: "cheap",
    routing: { priority: 40 }
  },
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
  }
];

const config = {
  routing: {
    fallbackChain: ["codex", "claude", "cursor", "antigravity"],
    smartRoute: {
      balanced: mergeSafeCheapTasks()
    },
    taskRoutes: { ask: "antigravity" }
  },
  providers: {
    antigravity: { enabled: true, model: "flash" },
    codex: { enabled: true, model: "gpt" },
    claude: { enabled: true, model: "opus" },
    cursor: { enabled: true, model: "sonnet" }
  }
};

test("classifyProviderError detects timeout", () => {
  assert.equal(classifyProviderError(new Error("request timed out after 1000ms")), "provider_timeout");
});

test("buildProviderSwitch requires raw_error_summary for unknown", () => {
  const row = buildProviderSwitch({
    originalSmartProvider: "antigravity",
    attemptedProvider: "antigravity",
    attemptedModel: "flash",
    fallbackToProvider: "codex",
    fallbackReason: "unknown",
    rawError: "something weird"
  });
  assert.equal(row.fallback_reason, "unknown");
  assert.ok(row.raw_error_summary);
});

test("buildSmartRouteAttempts keeps cheap chain before premium for safe tasks", () => {
  const attempts = buildSmartRouteAttempts({
    config,
    registry,
    primary: "antigravity",
    legacyProvider: "antigravity",
    smartDecision: { task_type: "chat", complexity: 1, risk: 1, features: {} }
  });
  const names = attempts.map((row) => row.name);
  assert.equal(names[0], "antigravity");
  assert.ok(names.includes("codex"));
  assert.ok(!names.includes("claude"));
});

test("applyCheapTaskTierCeiling downgrades mid selection to cheap in shadow mode", () => {
  const shadowConfig = {
    ...config,
    routing: { ...config.routing, smartRoute: { mode: "shadow_test", balanced: mergeSafeCheapTasks() } }
  };
  const decision = { task_type: "rewrite", complexity: 1, risk: 1 };
  const selected = registry[1];
  const capped = applyCheapTaskTierCeiling(selected, registry, decision, shadowConfig);
  assert.equal(capped.provider, "antigravity");
});

test("aggregateExecutionRates splits provider fallback and quality escalation", () => {
  const rates = aggregateExecutionRates(
    [
      {
        provider_fallback_used: true,
        quality_escalation_used: false,
        total_fallback_used: true,
        task_type: "chat",
        complexity: 1,
        risk: 1,
        final_executed_provider: "codex"
      },
      {
        provider_fallback_used: false,
        quality_escalation_used: true,
        total_fallback_used: true,
        task_type: "chat",
        complexity: 1,
        risk: 1,
        final_executed_provider: "claude"
      }
    ],
    registry
  );
  assert.equal(rates.provider_fallback_rate, 0.5);
  assert.equal(rates.quality_escalation_rate, 0.5);
  assert.equal(rates.total_fallback_rate, 1);
});

test("buildExecutorAudit tracks intended vs final providers", () => {
  const audit = buildExecutorAudit(
    [
      {
        request_id: "a",
        smart_intended_provider: "antigravity",
        first_attempted_provider: "antigravity",
        final_executed_provider: "claude",
        legacy_provider: "antigravity",
        provider_switches: []
      }
    ],
    registry
  );
  assert.equal(audit.by_smart_intended.antigravity, 1);
  assert.equal(audit.by_final_executed.claude, 1);
});
