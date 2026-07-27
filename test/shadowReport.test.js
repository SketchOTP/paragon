import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateProviderHealth,
  buildShadowReport,
  detectDangerDowngrade,
  enrichDecision,
  estimateRowCost,
  evaluateAcceptanceGate,
  formatReportText
} from "../src/smartRoute/shadowReport.js";
import { checkBudget, getDailySpend } from "../src/smartRoute/budget.js";

const registry = [
  {
    id: "codex:default",
    provider: "codex",
    tier: "mid",
    cost_input_per_1m: 2.5,
    cost_output_per_1m: 10
  },
  {
    id: "claude:default",
    provider: "claude",
    tier: "premium",
    cost_input_per_1m: 3,
    cost_output_per_1m: 15
  },
  {
    id: "antigravity:flash",
    provider: "antigravity",
    tier: "cheap",
    cost_input_per_1m: 0.15,
    cost_output_per_1m: 0.6
  }
];

test("buildShadowReport handles empty logs", () => {
  const report = buildShadowReport([], registry);
  assert.equal(report.total_requests, 0);
  assert.equal(report.match_rate, 0);
  assert.equal(report.danger_downgrades, 0);
  assert.equal(report.acceptance_gate.ready_to_leave_shadow, false);
});

test("buildShadowReport aggregates mixed match and diff logs", () => {
  const decisions = [
    {
      request_id: "a",
      shadow_match: true,
      legacy_provider: "codex",
      smart_provider: "codex",
      legacy_tier: "mid",
      smart_tier: "mid",
      task_type: "code",
      complexity: 3,
      risk: 2,
      router_confidence: 0.9,
      input_tokens_est: 1000,
      output_tokens_est: 500,
      success: true,
      latency_ms: 1200
    },
    {
      request_id: "b",
      shadow_match: false,
      legacy_provider: "claude",
      smart_provider: "antigravity",
      legacy_tier: "premium",
      smart_tier: "cheap",
      task_type: "summarize",
      complexity: 2,
      risk: 1,
      router_confidence: 0.85,
      input_tokens_est: 800,
      output_tokens_est: 400,
      success: true,
      latency_ms: 900
    }
  ];

  const report = buildShadowReport(decisions, registry);
  assert.equal(report.total_requests, 2);
  assert.equal(report.shadow_matches, 1);
  assert.equal(report.shadow_diffs, 1);
  assert.equal(report.match_rate, 0.5);
  assert.ok(report.estimated_cost_legacy_usd > 0);
  assert.ok(report.estimated_cost_smart_usd > 0);
  assert.ok(report.estimated_savings_usd !== 0);
  assert.equal(report.by_legacy_provider.codex, 1);
  assert.equal(report.by_smart_provider.antigravity, 1);
});

test("detectDangerDowngrade flags high complexity tier downgrade", () => {
  const row = enrichDecision(
    {
      legacy_provider: "claude",
      smart_provider: "antigravity",
      complexity: 4,
      risk: 2,
      task_type: "code_debug"
    },
    registry
  );
  const result = detectDangerDowngrade(row);
  assert.equal(result.danger, true);
  assert.ok(result.reasons.includes("legacy_tier_higher_and_complexity_high"));
});

test("detectDangerDowngrade flags high risk non-premium smart tier", () => {
  const row = enrichDecision(
    {
      legacy_provider: "codex",
      smart_provider: "antigravity",
      complexity: 3,
      risk: 4,
      task_type: "code"
    },
    registry
  );
  const result = detectDangerDowngrade(row);
  assert.equal(result.danger, true);
  assert.ok(result.reasons.includes("high_risk_not_premium"));
});

test("detectDangerDowngrade flags high risk task on weak tier", () => {
  const row = enrichDecision(
    {
      legacy_provider: "codex",
      smart_provider: "antigravity",
      complexity: 3,
      risk: 2,
      task_type: "architecture"
    },
    registry
  );
  const result = detectDangerDowngrade(row);
  assert.equal(result.danger, true);
  assert.ok(result.reasons.includes("high_risk_task_on_weak_tier"));
});

test("aggregateProviderHealth computes success and fallback rates", () => {
  const health = aggregateProviderHealth([
    { selected_provider: "codex", success: true, latency_ms: 1000 },
    { selected_provider: "codex", success: false, fallback_used: true, timeout: true, validator_result: "fail" },
    { selected_provider: "claude", success: true, latency_ms: 2000 }
  ]);

  const codex = health.find((row) => row.provider === "codex");
  assert.ok(codex);
  assert.equal(codex.total, 2);
  assert.equal(codex.success_rate, 0.5);
  assert.equal(codex.timeout_rate, 0.5);
  assert.equal(codex.fallback_rate, 0.5);
  assert.equal(codex.validation_failure_rate, 0.5);
  assert.ok(codex.health_score < 0.5);
});

test("estimateRowCost uses registry pricing when cached cost missing", () => {
  const cost = estimateRowCost(
    {
      legacy_provider: "codex",
      input_tokens_est: 1_000_000,
      output_tokens_est: 0
    },
    registry,
    "legacy"
  );
  assert.equal(cost, 2.5);
});

test("evaluateAcceptanceGate requires 100 requests and low downgrade rate", () => {
  const gate = evaluateAcceptanceGate({
    total: 100,
    dangerDowngrades: 0,
    falseDowngradeRate: 0.03,
    lowConfidenceRate: 0.1,
    dangerCases: []
  });
  assert.equal(gate.ready_to_leave_shadow, true);

  const blocked = evaluateAcceptanceGate({
    total: 50,
    dangerDowngrades: 2,
    falseDowngradeRate: 0.08,
    lowConfidenceRate: 0.2,
    dangerCases: [{ reasons: ["high_risk_task_on_weak_tier"] }]
  });
  assert.equal(blocked.ready_to_leave_shadow, false);
});

test("checkBudget blocks max single request cost", () => {
  const result = checkBudget({ maxSingleRequestUsd: 0.5 }, 0.75, { decisions: [] });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "max_single_request_exceeded");
});

test("getDailySpend sums same-day decision costs", () => {
  const spend = getDailySpend(
    [
      { timestamp: "2026-07-02T10:00:00Z", cost_estimate: 0.1, smart_tier: "premium" },
      { timestamp: "2026-07-02T11:00:00Z", cost_estimate: 0.2, selected_tier: "cheap" },
      { timestamp: "2026-07-01T11:00:00Z", cost_estimate: 9.9 }
    ],
    new Date("2026-07-02T12:00:00Z")
  );
  assert.ok(Math.abs(spend.total - 0.3) < 0.0001);
  assert.equal(spend.premium, 0.1);
});

test("formatReportText includes key sections", () => {
  const text = formatReportText(
    buildShadowReport(
      [
        {
          shadow_match: false,
          legacy_provider: "claude",
          smart_provider: "antigravity",
          legacy_tier: "premium",
          smart_tier: "cheap",
          task_type: "architecture",
          complexity: 4,
          risk: 2,
          router_confidence: 0.6,
          input_tokens_est: 500,
          output_tokens_est: 500,
          success: true
        }
      ],
      registry
    )
  );
  assert.match(text, /SmartRoute Shadow Evaluation Report/);
  assert.match(text, /Danger downgrades/);
  assert.match(text, /Acceptance gate/);
});
