import assert from "node:assert/strict";
import test from "node:test";

test("parseOpenAiModelListResponse imports model IDs from API payload", async () => {
  const { parseOpenAiModelListResponse } = await import("../src/smartRoute/modelDiscovery.js");
  const ids = parseOpenAiModelListResponse({
    data: [{ id: "gpt-5.4-mini" }, { id: "gpt-4o" }]
  });
  assert.deepEqual(ids, ["gpt-5.4-mini", "gpt-4o"]);
});

test("parseOpenRouterModelListResponse imports pricing metadata", async () => {
  const { parseOpenRouterModelListResponse } = await import("../src/smartRoute/modelDiscovery.js");
  const rows = parseOpenRouterModelListResponse({
    data: [
      {
        id: "anthropic/claude-sonnet-4-6",
        context_length: 200000,
        pricing: { prompt: "0.000003", completion: "0.000015" }
      }
    ]
  });
  assert.equal(rows[0].id, "anthropic/claude-sonnet-4-6");
  assert.equal(rows[0].context_length, 200000);
  assert.ok(rows[0].pricing);
});

test("manual price override wins over official pricing", async () => {
  const { resolvePricing } = await import("../src/smartRoute/modelPricing.js");
  const row = { canonical_id: "openai:gpt-5.4-mini", provider: "openai", model: "gpt-5.4-mini" };
  const overrides = { "openai:gpt-5.4-mini": { input_per_1m: 0.01, output_per_1m: 0.02 } };
  const now = new Date().toISOString();
  const pricing = resolvePricing(row, overrides, {}, {}, now);
  assert.equal(pricing.input_per_1m, 0.01);
  assert.equal(pricing.pricing_source, "manual");
});

test("unknown pricing excludes cost-sensitive routing", async () => {
  const { pricingBlocksCostSensitiveRoute, hasKnownPricing } = await import(
    "../src/smartRoute/modelPricing.js"
  );
  const unknown = { pricing_source: "unknown", input_per_1m: null };
  assert.equal(hasKnownPricing(unknown), false);
  assert.equal(pricingBlocksCostSensitiveRoute(unknown), true);
  assert.equal(
    pricingBlocksCostSensitiveRoute({
      pricing_source: "official_openai",
      pricing_status: "valid",
      input_per_1m: 1,
      output_per_1m: 2,
      cost_sensitive_eligible: true
    }),
    false
  );
});

test("exact benchmark match uses full confidence", async () => {
  const { enrichModelBenchmarks } = await import("../src/smartRoute/modelBenchmarks.js");
  const models = [
    { canonical_id: "claude:claude-sonnet-4-6", provider: "claude", model: "claude-sonnet-4-6" }
  ];
  const enriched = await enrichModelBenchmarks(models);
  assert.equal(enriched[0].benchmarks.swe_bench_verified_resolved, 56.2);
  assert.equal(enriched[0].benchmarks.benchmark_confidence, 1);
});

test("fuzzy benchmark match uses reduced confidence", async () => {
  const { enrichModelBenchmarks } = await import("../src/smartRoute/modelBenchmarks.js");
  const models = [{ canonical_id: "openai:gpt-5-new-mini", provider: "openai", model: "gpt-5-new-mini" }];
  const enriched = await enrichModelBenchmarks(models);
  assert.ok(enriched[0].benchmarks.swe_bench_verified_resolved != null);
  assert.ok(enriched[0].benchmarks.benchmark_confidence < 1);
  assert.ok(enriched[0].benchmarks.benchmark_confidence >= 0.5);
});

test("stale snapshot blocks all active SmartRoute modes", async () => {
  const { canUseSnapshotForActiveMode, isActiveSmartRouteMode, isSnapshotStale } = await import(
    "../src/smartRoute/modelSnapshotStore.js"
  );
  const old = {
    generated_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    stale: false,
    refresh_status: "ok",
    models: [{ canonical_id: "openai:gpt-5.4-mini" }]
  };
  assert.equal(isSnapshotStale(old, { maxSnapshotAgeHours: 36 }), true);
  for (const mode of ["balanced", "canary", "cost_saver", "maximum_quality", "local_private_first"]) {
    assert.equal(isActiveSmartRouteMode(mode), true);
    const gate = canUseSnapshotForActiveMode({ routing: { smartRoute: { mode } } }, old);
    assert.equal(gate.allowed, false, `${mode} should require fresh snapshot`);
    assert.equal(gate.reason, "model_intelligence_stale");
  }
  const shadow = canUseSnapshotForActiveMode({ routing: { smartRoute: { mode: "shadow_test" } } }, old);
  assert.equal(shadow.allowed, true);
});

test("price increase changes ranking order", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const baseHealth = {
    response_ok: true,
    success_rate_24h: 0.98,
    empty_response_rate: 0,
    timeout_rate: 0,
    avg_latency_ms: 1000
  };
  const cheap = {
    canonical_id: "openai:cheap",
    provider: "openai",
    model: "cheap",
    available: true,
    pricing: { input_per_1m: 0.5, output_per_1m: 1, pricing_source: "official_openai" },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { chat: 0.6 }, swe_bench_verified_resolved: null },
    health: baseHealth,
    capabilities: { json_mode: true }
  };
  const pricey = {
    ...cheap,
    canonical_id: "openai:pricey",
    model: "pricey",
    pricing: { input_per_1m: 5, output_per_1m: 10, pricing_source: "official_openai" }
  };
  let ranked = rankModelsForTask([cheap, pricey], "chat");
  assert.equal(ranked[0].model.canonical_id, "openai:cheap");

  cheap.pricing.input_per_1m = 20;
  cheap.pricing.output_per_1m = 20;
  ranked = rankModelsForTask([cheap, pricey], "chat");
  assert.equal(ranked[0].model.canonical_id, "openai:pricey");
});

test("unhealthy cheap model excluded from rankings", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const model = {
    canonical_id: "antigravity:default",
    provider: "antigravity",
    model: "default",
    available: true,
    pricing: { input_per_1m: 0.1, output_per_1m: 0.2, pricing_source: "manual" },
    benchmarks: { benchmark_confidence: 0.5, paragon_eval: { chat: 0.55 } },
    health: {
      response_ok: false,
      success_rate_24h: 0.5,
      empty_response_rate: 0.2,
      timeout_rate: 0,
      last_probe_status: "fail"
    },
    health_excluded: true,
    capabilities: { json_mode: true }
  };
  const ranked = rankModelsForTask([model], "chat");
  assert.equal(ranked.length, 0);
});

test("local model loses when reliability is poor", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const local = {
    canonical_id: "local:gemma",
    provider: "local",
    model: "gemma",
    local: true,
    available: true,
    pricing: { input_per_1m: 0, output_per_1m: 0, pricing_source: "manual" },
    benchmarks: { benchmark_confidence: 0.5, paragon_eval: { chat: 0.55 } },
    health: { response_ok: true, success_rate_24h: 0.6, empty_response_rate: 0, timeout_rate: 0.15, avg_latency_ms: 8000 },
    capabilities: { json_mode: true }
  };
  const cloud = {
    canonical_id: "openai:gpt-4o-mini",
    provider: "openai",
    model: "gpt-4o-mini",
    available: true,
    pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_source: "official_openai" },
    benchmarks: { benchmark_confidence: 0.9, paragon_eval: { chat: 0.6 } },
    health: { response_ok: true, success_rate_24h: 0.98, empty_response_rate: 0, timeout_rate: 0, avg_latency_ms: 900 },
    capabilities: { json_mode: true }
  };
  const ranked = rankModelsForTask([local, cloud], "chat");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].model.canonical_id, "openai:gpt-4o-mini");
});

test("local model wins when reliability and eval score are strong", async () => {
  const { rankModelsForTask } = await import("../src/smartRoute/modelRanker.js");
  const local = {
    canonical_id: "local:gemma",
    provider: "local",
    model: "gemma",
    local: true,
    available: true,
    pricing: { input_per_1m: 0, output_per_1m: 0, pricing_source: "manual" },
    benchmarks: { benchmark_confidence: 0.85, paragon_eval: { chat: 0.72 } },
    health: { response_ok: true, success_rate_24h: 0.99, empty_response_rate: 0, timeout_rate: 0, avg_latency_ms: 400 },
    capabilities: { json_mode: true }
  };
  const cloud = {
    canonical_id: "openai:gpt-4o-mini",
    provider: "openai",
    model: "gpt-4o-mini",
    available: true,
    pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_source: "official_openai" },
    benchmarks: { benchmark_confidence: 0.7, paragon_eval: { chat: 0.58 } },
    health: { response_ok: true, success_rate_24h: 0.95, empty_response_rate: 0, timeout_rate: 0, avg_latency_ms: 1200 },
    capabilities: { json_mode: true }
  };
  const ranked = rankModelsForTask([local, cloud], "chat");
  assert.equal(ranked[0].model.canonical_id, "local:gemma");
});

test("SWE-bench used for code tasks only", async () => {
  const { taskQualityScore, usesSweBenchForTask } = await import("../src/smartRoute/modelBenchmarks.js");
  const benchmarks = {
    swe_bench_verified_resolved: 60,
    paragon_eval: { chat: 0.4, code: 0.3 }
  };
  assert.equal(usesSweBenchForTask("code"), true);
  assert.equal(usesSweBenchForTask("chat"), false);
  assert.ok(taskQualityScore(benchmarks, "code") > taskQualityScore(benchmarks, "chat"));
});

test("non-code tasks use PARAGON eval not SWE-bench", async () => {
  const { taskQualityScore } = await import("../src/smartRoute/modelBenchmarks.js");
  const benchmarks = {
    swe_bench_verified_resolved: 90,
    paragon_eval: { chat: 0.35, rewrite: 0.38, summarize: 0.4 }
  };
  assert.equal(taskQualityScore(benchmarks, "chat"), 0.35);
  assert.equal(taskQualityScore(benchmarks, "rewrite"), 0.38);
});

test("detectChanges reports price increases over 25%", async () => {
  const { detectChanges } = await import("../src/smartRoute/modelIntelligenceRefresh.js");
  const previous = {
    models: [
      {
        canonical_id: "openai:gpt-5.4-mini",
        pricing: { input_per_1m: 1 },
        benchmarks: {},
        health: { response_ok: true }
      }
    ],
    rankings: { chat: [{ canonical_id: "openai:gpt-5.4-mini" }] }
  };
  const models = [
    {
      canonical_id: "openai:gpt-5.4-mini",
      pricing: { input_per_1m: 1.4 },
      benchmarks: {},
      health: { response_ok: true }
    }
  ];
  const rankings = { chat: [{ canonical_id: "openai:gpt-5.4-mini" }] };
  const changes = detectChanges(previous, models, rankings);
  assert.ok(changes.price_changes.length >= 1);
  assert.ok(changes.critical_alerts.some((a) => a.type === "price_increase"));
});

test("daily refresh snapshot payload shape", async () => {
  const { emptySnapshot } = await import("../src/smartRoute/modelSnapshotStore.js");
  const snapshot = {
    ...emptySnapshot(),
    generated_at: new Date().toISOString(),
    stale: false,
    refresh_status: "ok",
    models: [{ canonical_id: "openai:test", provider: "openai", model: "test", available: true }],
    rankings: { chat: [{ canonical_id: "openai:test", rank: 1, score: 1.2 }] }
  };
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.refresh_status, "ok");
  assert.ok(snapshot.rankings.chat?.length);
});

test("failed refresh preserves last known good snapshot", async () => {
  const { detectChanges } = await import("../src/smartRoute/modelIntelligenceRefresh.js");
  const previous = {
    models: [{ canonical_id: "openai:kept", provider: "openai", model: "kept" }],
    rankings: {}
  };
  const failed = {
    ...previous,
    stale: true,
    refresh_status: "failed",
    last_error: "probe timeout"
  };
  assert.equal(failed.models[0].canonical_id, previous.models[0].canonical_id);
  assert.equal(failed.stale, true);
  const changes = detectChanges(previous, previous.models, {});
  assert.equal(changes.new_models.length, 0);
});

test("cheap-task trial readiness ignores antigravity-only failure", async () => {
  const { checkCheapTaskTrialReadiness } = await import("../src/smartRoute/modelRanker.js");
  const rankings = {
    chat: [{ canonical_id: "cursor:default", provider: "cursor", rank: 1 }],
    rewrite: [{ canonical_id: "cursor:default", provider: "cursor", rank: 1 }],
    summarize: [{ canonical_id: "codex:default", provider: "codex", rank: 1 }],
    extract_json: [{ canonical_id: "codex:default", provider: "codex", rank: 1 }]
  };
  const readiness = checkCheapTaskTrialReadiness(rankings);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.antigravity_ranked, false);
  assert.equal(readiness.missing.length, 0);
});

test("buildPreflightDiagnostics reports top excluded with scores", async () => {
  const { buildPreflightDiagnostics } = await import("../src/smartRoute/modelRanker.js");
  const models = [
    {
      canonical_id: "cursor:default",
      provider: "cursor",
      model: "default",
      available: true,
      pricing: { input_per_1m: 0.15, output_per_1m: 0.6, pricing_source: "official_openai" },
      benchmarks: { benchmark_confidence: 0.8, paragon_eval: { chat: 0.6 } },
      health: { response_ok: true, success_rate_24h: 0.88, last_probe_status: "pass" }
    }
  ];
  const diag = buildPreflightDiagnostics(models, ["chat"]);
  assert.equal(diag.per_task.length, 1);
  assert.equal(diag.per_task[0].passes, false);
  assert.ok(diag.per_task[0].top_excluded.length >= 1);
  assert.equal(diag.per_task[0].top_excluded[0].exclusion_reason, "below_min_reliability");
  assert.equal(diag.per_task[0].top_excluded[0].pricing_status, "known");
});

test("isScheduledMinute matches cron hour and minute in timezone", async () => {
  const { isScheduledMinute } = await import("../src/smartRoute/modelRefreshScheduler.js");
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  assert.equal(isScheduledMinute(`${m} ${h} * * *`, "UTC"), true);
  assert.equal(isScheduledMinute(`${(m + 1) % 60} ${h} * * *`, "UTC"), false);
});
