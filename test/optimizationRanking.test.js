import assert from "node:assert/strict";
import test from "node:test";

function model(id, overrides = {}) {
  const [provider, ...rest] = id.split(":");
  const name = rest.join(":");
  return {
    canonical_id: id,
    provider,
    model: name,
    available: true,
    tier: overrides.tier,
    pricing: {
      input_per_1m: 1,
      output_per_1m: 2,
      pricing_source: "official_pricing",
      pricing_status: "valid",
      pricing_confidence: 0.9,
      cost_sensitive_eligible: true,
      source_url: "https://example.com/pricing",
      ...(overrides.pricing ?? {})
    },
    benchmarks: {
      benchmark_confidence: 0.8,
      paragon_eval: { chat: 0.5, rewrite: 0.5, summarize: 0.5, extract: 0.5 },
      ...(overrides.benchmarks ?? {})
    },
    health: {
      response_ok: true,
      success_rate_24h: 0.98,
      health_source: "direct_probe",
      health_confidence: 1,
      avg_latency_ms: 1000,
      last_probe_status: "pass",
      ...(overrides.health ?? {})
    },
    capabilities: { json_mode: true, ...(overrides.capabilities ?? {}) },
    ...overrides
  };
}

test("cheap task selects lower-cost model over higher-quality premium", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const cheap = model("antigravity:flash", {
    tier: "cheap",
    pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { rewrite: 0.45 } }
  });
  const premium = model("codex:gpt-5.4", {
    tier: "premium",
    pricing: { input_per_1m: 2.5, output_per_1m: 15, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    benchmarks: { benchmark_confidence: 0.95, paragon_eval: { rewrite: 0.95 } }
  });

  const ranked = rankModelsForTask([premium, cheap], "rewrite", {
    mode: "balanced",
    complexity: 1,
    risk: 1,
    costSensitive: true
  });

  assert.equal(ranked[0].model.canonical_id, "antigravity:flash");
  assert.equal(ranked[0].explanation.selection_strategy, "min_cost_above_floor");
  assert.equal(ranked[0].explanation.premium_blocked, true);
  assert.equal(ranked[0].explanation.premium_block_reason, "cheaper_model_passed_floor");
});

test("premium wins only when no cheaper model passes floor", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const weakCheap = model("antigravity:flash", {
    tier: "cheap",
    pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    health: { response_ok: false, success_rate_24h: 0.4, health_source: "direct_probe", health_confidence: 1, last_probe_status: "fail" }
  });
  const premium = model("codex:gpt-5.4", {
    tier: "premium",
    pricing: { input_per_1m: 2.5, output_per_1m: 15, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    benchmarks: { benchmark_confidence: 0.9, paragon_eval: { rewrite: 0.8 } }
  });

  const ranked = rankModelsForTask([weakCheap, premium], "rewrite", {
    mode: "balanced",
    complexity: 1,
    risk: 1,
    costSensitive: true
  });

  assert.equal(ranked[0].model.canonical_id, "codex:gpt-5.4");
  assert.equal(ranked[0].explanation.premium_blocked, false);
});

test("maximum_quality can select premium", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const cheap = model("antigravity:flash", {
    tier: "cheap",
    pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { rewrite: 0.45 } }
  });
  const premium = model("codex:gpt-5.4", {
    tier: "premium",
    pricing: { input_per_1m: 2.5, output_per_1m: 15, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    benchmarks: { benchmark_confidence: 0.95, paragon_eval: { rewrite: 0.95 } }
  });

  const ranked = rankModelsForTask([cheap, premium], "rewrite", {
    mode: "maximum_quality",
    complexity: 1,
    risk: 1,
    costSensitive: true
  });

  assert.equal(ranked[0].model.canonical_id, "codex:gpt-5.4");
  assert.equal(ranked[0].explanation.selection_strategy, "max_quality_with_cost_awareness");
});

test("balanced blocks premium when cheaper model passes floor", async () => {
  const { explainRanking } = await import("../src/smartRoute/modelRanker.js");
  const cheap = model("claude:claude-haiku-4-5", {
    tier: "cheap",
    pricing: { input_per_1m: 0.8, output_per_1m: 4, pricing_status: "valid", pricing_confidence: 0.85, cost_sensitive_eligible: true, pricing_source: "underlying_direct_price", source_url: "https://anthropic" },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { rewrite: 0.5 } }
  });
  const premium = model("codex:gpt-5.4", {
    tier: "premium",
    pricing: { input_per_1m: 2.5, output_per_1m: 15, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://openai" },
    benchmarks: { benchmark_confidence: 0.95, paragon_eval: { rewrite: 0.9 } }
  });

  const report = explainRanking([cheap, premium], "rewrite", {
    mode: "balanced",
    complexity: 1,
    risk: 1,
    costSensitive: true
  });

  assert.equal(report.winner_canonical_id, "claude:claude-haiku-4-5");
  assert.equal(report.premium_blocked, true);
  assert.equal(report.premium_block_reason, "cheaper_model_passed_floor");
  assert.ok(report.runner_ups.some((r) => r.canonical_id === "codex:gpt-5.4"));
});

test("extract_json prefers model that passes JSON floor", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const cheapFailJson = model("antigravity:flash", {
    tier: "cheap",
    pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    health: {
      response_ok: true,
      success_rate_24h: 0.98,
      health_source: "direct_probe",
      health_confidence: 1,
      last_probe_status: "fail"
    },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { extract: 0.5 } }
  });
  const midPassJson = model("claude:claude-haiku-4-5", {
    tier: "mid",
    pricing: { input_per_1m: 0.8, output_per_1m: 4, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    health: {
      response_ok: true,
      success_rate_24h: 0.98,
      health_source: "direct_probe",
      health_confidence: 1,
      last_probe_status: "pass"
    },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { extract: 0.55 } }
  });

  const ranked = rankModelsForTask([cheapFailJson, midPassJson], "extract_json", {
    mode: "balanced",
    complexity: 1,
    risk: 1,
    costSensitive: true,
    requiresStrictJson: true
  });

  assert.equal(ranked[0].model.canonical_id, "claude:claude-haiku-4-5");
});

test("ranking explanation includes winner and premium block reasons", async () => {
  const { explainRanking } = await import("../src/smartRoute/modelRanker.js");
  const cheap = model("antigravity:flash", {
    tier: "cheap",
    pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { chat: 0.5 } }
  });
  const premium = model("codex:gpt-5.4", {
    tier: "premium",
    pricing: { input_per_1m: 2.5, output_per_1m: 15, pricing_status: "valid", pricing_confidence: 0.9, cost_sensitive_eligible: true, pricing_source: "official_pricing", source_url: "https://x" },
    benchmarks: { benchmark_confidence: 0.95, paragon_eval: { chat: 0.9 } }
  });

  const report = explainRanking([cheap, premium], "chat", {
    mode: "balanced",
    complexity: 1,
    risk: 1,
    costSensitive: true
  });

  assert.equal(report.selection_strategy, "min_cost_above_floor");
  assert.equal(report.winner_reason, "lowest_effective_cost_above_floor");
  assert.equal(report.premium_block_reason, "cheaper_model_passed_floor");
  assert.ok(report.passed_floor.length >= 1);
  assert.ok(report.runner_ups.some((r) => r.excluded_reason === "premium_not_needed_for_safe_cheap_task"));
});

test("negative savings smoke condition blocks 20-request trial readiness", async () => {
  // Gate helper: positive savings required before full trial
  function smokeAllowsFullTrial({ httpOk, total, mismatch, savings, strategy }) {
    return (
      total >= 3 &&
      httpOk === total &&
      mismatch === 0 &&
      savings > 0 &&
      strategy === "min_cost_above_floor"
    );
  }

  assert.equal(
    smokeAllowsFullTrial({
      httpOk: 3,
      total: 3,
      mismatch: 0,
      savings: -0.02,
      strategy: "min_cost_above_floor"
    }),
    false
  );
  assert.equal(
    smokeAllowsFullTrial({
      httpOk: 3,
      total: 3,
      mismatch: 0,
      savings: 0.01,
      strategy: "min_cost_above_floor"
    }),
    true
  );
});
