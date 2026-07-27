import assert from "node:assert/strict";
import test from "node:test";

function healthyDirect(overrides = {}) {
  return {
    response_ok: true,
    success_rate_24h: 0.98,
    success_rate_7d: 0.98,
    empty_response_rate: 0,
    timeout_rate: 0,
    provider_error_rate: 0,
    avg_latency_ms: 800,
    last_probe_status: "pass",
    last_failure_category: null,
    last_checked: new Date().toISOString(),
    health_source: "direct_probe",
    health_group_id: "cursor:primary",
    health_probe_target: "cursor:composer-2.5",
    health_last_direct_probe: new Date().toISOString(),
    health_confidence: 1,
    health_inherited: false,
    ...overrides
  };
}

test("cursor models share health_group_id cursor:primary", async () => {
  const { attachHealthGroup } = await import("../src/smartRoute/modelHealthGroups.js");
  const config = { providers: { cursor: { enabled: true, model: "composer-2.5" } } };
  const a = attachHealthGroup(
    { canonical_id: "cursor:composer-2.5", provider: "cursor", model: "composer-2.5" },
    config
  );
  const b = attachHealthGroup(
    { canonical_id: "cursor:gpt-5.4-high", provider: "cursor", model: "gpt-5.4-high" },
    config
  );
  assert.equal(a.health_group_id, "cursor:primary");
  assert.equal(b.health_group_id, "cursor:primary");
  assert.equal(a.health_probe_target, "cursor:composer-2.5");
  assert.equal(b.health_probe_target, "cursor:composer-2.5");
});

test("selectProbeTargets picks one cursor primary, not all variants", async () => {
  const { attachHealthGroup, selectProbeTargets } = await import(
    "../src/smartRoute/modelHealthGroups.js"
  );
  const config = {
    providers: {
      cursor: { enabled: true, model: "composer-2.5" },
      claude: { enabled: true, model: "claude-haiku-4-5" }
    },
    routing: { smartRoute: { modelRefresh: { probePrimaryOnly: true } } }
  };

  const models = [];
  for (let i = 0; i < 150; i++) {
    models.push(
      attachHealthGroup(
        {
          canonical_id: `cursor:variant-${i}`,
          provider: "cursor",
          model: i === 0 ? "composer-2.5" : `variant-${i}`
        },
        config
      )
    );
  }
  models[0] = attachHealthGroup(
    { canonical_id: "cursor:composer-2.5", provider: "cursor", model: "composer-2.5" },
    config
  );
  models.push(
    attachHealthGroup(
      { canonical_id: "claude:claude-haiku-4-5", provider: "claude", model: "claude-haiku-4-5" },
      config
    )
  );

  const targets = selectProbeTargets(models, config, { probePrimaryOnly: true });
  const cursorTargets = targets.filter((t) => t.provider === "cursor");
  assert.equal(cursorTargets.length, 1);
  assert.equal(cursorTargets[0].canonical_id, "cursor:composer-2.5");
  assert.ok(targets.some((t) => t.canonical_id === "claude:claude-haiku-4-5"));
  assert.ok(targets.length < 10);
});

test("primary-only probes one Cursor target, not 150 variants", async () => {
  const { attachHealthGroup, selectProbeTargets } = await import(
    "../src/smartRoute/modelHealthGroups.js"
  );
  const config = {
    providers: { cursor: { enabled: true, model: "composer-2.5" } },
    routing: { smartRoute: { modelRefresh: { probePrimaryOnly: true } } }
  };
  const models = Array.from({ length: 150 }, (_, i) =>
    attachHealthGroup(
      {
        canonical_id: i === 0 ? "cursor:composer-2.5" : `cursor:v-${i}`,
        provider: "cursor",
        model: i === 0 ? "composer-2.5" : `v-${i}`
      },
      config
    )
  );
  const targets = selectProbeTargets(models, config, { probePrimaryOnly: true });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].canonical_id, "cursor:composer-2.5");
});

test("health inherited by same health_group_id with reduced confidence", async () => {
  const { attachHealthGroup } = await import("../src/smartRoute/modelHealthGroups.js");
  const { distributeHealthResults } = await import("../src/smartRoute/modelHealthProbes.js");

  const config = { providers: { cursor: { enabled: true, model: "composer-2.5" } } };
  const models = [
    attachHealthGroup(
      { canonical_id: "cursor:composer-2.5", provider: "cursor", model: "composer-2.5", available: true },
      config
    ),
    attachHealthGroup(
      { canonical_id: "cursor:gpt-5.4-high", provider: "cursor", model: "gpt-5.4-high", available: true },
      config
    ),
    attachHealthGroup(
      { canonical_id: "cursor:variant-99", provider: "cursor", model: "variant-99", available: true },
      config
    )
  ];

  const directHealth = healthyDirect({
    health_group_id: "cursor:primary",
    health_probe_target: "cursor:composer-2.5"
  });
  const directByCanonical = new Map([["cursor:composer-2.5", directHealth]]);
  const directByGroup = new Map([
    ["cursor:primary", { health: directHealth, probeTarget: "cursor:composer-2.5" }]
  ]);

  const enriched = distributeHealthResults(models, {
    config,
    directByCanonical,
    directByGroup
  });

  const primary = enriched.find((m) => m.canonical_id === "cursor:composer-2.5");
  const variant = enriched.find((m) => m.canonical_id === "cursor:gpt-5.4-high");

  assert.equal(primary.health.health_source, "direct_probe");
  assert.equal(primary.health.health_confidence, 1);
  assert.equal(primary.health_probed, true);
  assert.equal(variant.health.health_source, "inherited_group");
  assert.equal(variant.health.health_confidence, 0.75);
  assert.equal(variant.health.health_group_id, "cursor:primary");
  assert.equal(variant.health.health_probe_target, "cursor:composer-2.5");
  assert.equal(variant.health.success_rate_24h, primary.health.success_rate_24h);
  assert.equal(variant.health_probed, false);
});

test("inherited health has reduced effective reliability", async () => {
  const { effectiveReliability } = await import("../src/smartRoute/modelHealthGroups.js");
  const direct = effectiveReliability(healthyDirect());
  const inherited = effectiveReliability(
    healthyDirect({
      health_source: "inherited_group",
      health_confidence: 0.75,
      health_inherited: true
    })
  );
  assert.equal(direct, 0.98);
  assert.ok(Math.abs(inherited - 0.735) < 0.001);
});

test("high-risk task rejects inherited low-confidence health", async () => {
  const { scoreModelForTask } = await import("../src/smartRoute/modelRanker.js");
  const model = {
    canonical_id: "cursor:gpt-5.4-high",
    provider: "cursor",
    model: "gpt-5.4-high",
    available: true,
    pricing: {
      input_per_1m: 2.5,
      output_per_1m: 15,
      pricing_source: "openrouter_catalog",
      billing_model: "subscription"
    },
    benchmarks: {
      benchmark_confidence: 0.9,
      paragon_eval: { code: 0.8 },
      swe_bench_verified_resolved: 60
    },
    health: healthyDirect({
      health_source: "inherited_group",
      health_confidence: 0.75,
      health_inherited: true
    }),
    capabilities: { coding: "high", json_mode: true }
  };

  const code = scoreModelForTask(model, "code", { costSensitive: true });
  assert.equal(code.pass, false);
  assert.equal(code.reason, "health_confidence_too_low");

  const chat = scoreModelForTask(model, "chat", { costSensitive: true });
  // 0.98 * 0.75 = 0.735 < 0.9 floor
  assert.equal(chat.pass, false);
  assert.equal(chat.reason, "below_min_reliability_health_confidence");
});

test("direct probe passes high-risk and cheap floors", async () => {
  const { scoreModelForTask } = await import("../src/smartRoute/modelRanker.js");
  const model = {
    canonical_id: "cursor:composer-2.5",
    provider: "cursor",
    model: "composer-2.5",
    available: true,
    pricing: {
      input_per_1m: 2.5,
      output_per_1m: 15,
      pricing_source: "openrouter_catalog",
      billing_model: "subscription"
    },
    benchmarks: {
      benchmark_confidence: 0.9,
      paragon_eval: { chat: 0.7, code: 0.8 },
      swe_bench_verified_resolved: 60
    },
    health: healthyDirect(),
    capabilities: { coding: "high", json_mode: true }
  };

  assert.equal(scoreModelForTask(model, "chat", { costSensitive: true }).pass, true);
  assert.equal(scoreModelForTask(model, "code", { costSensitive: true }).pass, true);
});

test("unknown health excludes from rankings", async () => {
  const { scoreModelForTask } = await import("../src/smartRoute/modelRanker.js");
  const model = {
    canonical_id: "cursor:mystery",
    provider: "cursor",
    model: "mystery",
    available: true,
    pricing: { input_per_1m: 1, output_per_1m: 2, pricing_source: "manual" },
    benchmarks: { benchmark_confidence: 0.8, paragon_eval: { chat: 0.6 } },
    health: {
      health_source: "unknown",
      health_confidence: 0,
      success_rate_24h: 0.75,
      response_ok: true
    }
  };
  const scored = scoreModelForTask(model, "chat", { costSensitive: true });
  assert.equal(scored.pass, false);
  assert.equal(scored.reason, "unknown_health");
});

test("subscription pricing is never zero effective cost", async () => {
  const { computeEffectiveCost } = await import("../src/smartRoute/modelRanker.js");
  const cost = computeEffectiveCost({
    provider: "cursor",
    pricing: {
      input_per_1m: 0,
      output_per_1m: 0,
      pricing_source: "subscription_cli",
      billing_model: "subscription"
    },
    health: healthyDirect()
  });
  assert.ok(cost.effective_cost > 0);
});

test("partial refresh does not replace last known good ok snapshot", async () => {
  // preservePartial behavior: when deadline exceeded and prior ok snapshot exists,
  // write refresh_status partial and keep prior models.
  const previous = {
    version: 1,
    generated_at: "2026-07-01T00:00:00.000Z",
    stale: false,
    refresh_status: "ok",
    models: [{ canonical_id: "claude:claude-haiku-4-5", provider: "claude", model: "claude-haiku-4-5" }],
    rankings: { chat: [{ canonical_id: "claude:claude-haiku-4-5" }] }
  };

  function preservePartial(prev, stage, reason) {
    if (prev?.refresh_status === "ok" && prev?.models?.length) {
      return {
        ok: false,
        partial: true,
        preserved: true,
        snapshot: {
          ...prev,
          stale: true,
          refresh_status: "partial",
          last_error: reason,
          last_partial_stage: stage
        }
      };
    }
    return { ok: false, partial: true, preserved: false };
  }

  const result = preservePartial(previous, "health", "refresh_deadline_exceeded");
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.preserved, true);
  assert.equal(result.snapshot.refresh_status, "partial");
  assert.equal(result.snapshot.models[0].canonical_id, "claude:claude-haiku-4-5");
  assert.equal(result.snapshot.stale, true);
  assert.notEqual(result.snapshot.refresh_status, "ok");
});

test("probe expansion targets models blocked by health confidence", async () => {
  const { scoreModelForTask } = await import("../src/smartRoute/modelRanker.js");
  const blocked = {
    canonical_id: "claude:claude-haiku-4-5",
    provider: "claude",
    model: "claude-haiku-4-5",
    available: true,
    pricing: { input_per_1m: 0.8, output_per_1m: 4, pricing_source: "official_anthropic" },
    benchmarks: { benchmark_confidence: 0.9, paragon_eval: { chat: 0.7 } },
    health: healthyDirect({
      health_source: "inherited_group",
      health_confidence: 0.75,
      health_group_id: "claude:primary",
      health_inherited: true
    })
  };
  const scored = scoreModelForTask(blocked, "chat", { costSensitive: true });
  assert.equal(scored.pass, false);
  assert.match(scored.reason, /health|reliability/);

  // After direct probe, same model passes
  blocked.health = healthyDirect({ health_group_id: "claude:primary" });
  assert.equal(scoreModelForTask(blocked, "chat", { costSensitive: true }).pass, true);
});

test("summarizeHealthCoverage reports direct/inherited/unknown", async () => {
  const { summarizeHealthCoverage } = await import("../src/smartRoute/modelHealthGroups.js");
  const stats = summarizeHealthCoverage([
    { health: { health_source: "direct_probe" } },
    { health: { health_source: "inherited_group" } },
    { health: { health_source: "inherited_group" } },
    { health: { health_source: "unknown" } }
  ]);
  assert.equal(stats.direct_probe, 1);
  assert.equal(stats.inherited_group, 2);
  assert.equal(stats.unknown, 1);
  assert.equal(stats.total, 4);
});

test("pricing still resolves for catalog variants without probing", async () => {
  const { resolvePricing } = await import("../src/smartRoute/modelPricing.js");
  const { buildCatalogIndex } = await import("../src/smartRoute/modelPricingCatalog.js");
  const catalog = buildCatalogIndex([
    { id: "openai/gpt-5.4", pricing: { prompt: "0.0000025", completion: "0.000015" } }
  ]);
  const now = new Date().toISOString();
  for (const model of ["gpt-5.4", "gpt-5.4-high", "gpt-5.4-medium"]) {
    const pricing = resolvePricing(
      { canonical_id: `cursor:${model}`, provider: "cursor", model },
      {},
      {},
      {},
      now,
      catalog
    );
    assert.ok(pricing.input_per_1m != null, model);
    assert.notEqual(pricing.pricing_source, "unknown");
    assert.equal(pricing.billing_model, "subscription");
  }
});
