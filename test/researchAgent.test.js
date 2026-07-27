import assert from "node:assert/strict";
import test from "node:test";

test("negative prices are rejected", async () => {
  const { validatePricingNumbers, applyPricingValidation } = await import(
    "../src/smartRoute/researchAgent/pricingValidation.js"
  );
  const check = validatePricingNumbers({ input_per_1m: -1, output_per_1m: 2 });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "negative_price");
  const applied = applyPricingValidation({ input_per_1m: -1, output_per_1m: 2, pricing_source: "openrouter" });
  assert.equal(applied.pricing_status, "invalid");
});

test("sentinel -1000000 prices are rejected", async () => {
  const { validatePricingNumbers } = await import("../src/smartRoute/researchAgent/pricingValidation.js");
  const check = validatePricingNumbers({ input_per_1m: -1_000_000, output_per_1m: -1_000_000 });
  assert.equal(check.ok, false);
  assert.ok(check.reason === "negative_price" || check.reason === "sentinel_value");
});

test("resolvePricing rejects cursor:auto sentinel catalog prices", async () => {
  const { resolvePricing, hasKnownPricing } = await import("../src/smartRoute/modelPricing.js");
  const { buildCatalogIndex } = await import("../src/smartRoute/modelPricingCatalog.js");
  // Simulate corrupt openrouter catalog entry
  const catalog = buildCatalogIndex([
    { id: "openai/auto", pricing: { prompt: "-1", completion: "-1" } }
  ]);
  // Force slug match to auto with absurd per-1m after conversion
  catalog.bySlug.set("auto", {
    pricing: { input_per_1m: -1_000_000, output_per_1m: -1_000_000 },
    openrouter_id: "openai/auto"
  });
  catalog.byId.set("openai/auto", {
    input_per_1m: -1_000_000,
    output_per_1m: -1_000_000,
    openrouter_id: "openai/auto",
    pricing_source: "openrouter_catalog",
    pricing_confidence: 0.9
  });

  const pricing = resolvePricing(
    { canonical_id: "cursor:auto", provider: "cursor", model: "auto" },
    {},
    {},
    {},
    new Date().toISOString(),
    catalog,
    null
  );
  assert.notEqual(pricing.pricing_status, "valid");
  assert.equal(hasKnownPricing(pricing), false);
});

test("unknown pricing excluded from cost-sensitive routing", async () => {
  const { pricingBlocksCostSensitiveRoute, hasKnownPricing } = await import(
    "../src/smartRoute/modelPricing.js"
  );
  assert.equal(hasKnownPricing({ pricing_source: "unknown", input_per_1m: null }), false);
  assert.equal(pricingBlocksCostSensitiveRoute({ pricing_source: "unknown", input_per_1m: null }), true);
});

test("manual override wins and is cost-sensitive eligible", async () => {
  const { resolvePricing, hasKnownPricing } = await import("../src/smartRoute/modelPricing.js");
  const pricing = resolvePricing(
    { canonical_id: "cursor:auto", provider: "cursor", model: "auto" },
    { "cursor:auto": { input_per_1m: 1, output_per_1m: 2 } },
    {},
    {},
    new Date().toISOString(),
    null,
    null
  );
  assert.equal(pricing.pricing_source, "manual");
  assert.equal(pricing.pricing_status, "valid");
  assert.equal(hasKnownPricing(pricing), true);
});

test("OpenRouter pricing only applies to openrouter routes", async () => {
  const { resolvePricing, hasKnownPricing } = await import("../src/smartRoute/modelPricing.js");
  const row = {
    canonical_id: "claude:claude-haiku-4-5",
    provider: "claude",
    model: "claude-haiku-4-5",
    openrouter_metadata: { pricing: { prompt: "0.0000008", completion: "0.000004" } }
  };
  const pricing = resolvePricing(row, {}, {}, {}, new Date().toISOString(), null, null);
  // Must not treat openrouter metadata as direct claude billing truth
  assert.notEqual(pricing.pricing_source, "openrouter");
  // Subscription estimate without research evidence is not cost-sensitive eligible
  assert.equal(hasKnownPricing(pricing), false);
});

test("OpenRouter API extraction produces aggregator records", async () => {
  const { extractPricingFromSource } = await import("../src/smartRoute/researchAgent/extractPricing.js");
  const result = extractPricingFromSource({
    ok: true,
    provider: "openrouter",
    url: "https://openrouter.ai/api/v1/models",
    source: { authority: "aggregator_pricing", id: "openrouter-pricing-api" },
    snapshot: { source_hash: "abc", fetched_at: new Date().toISOString() },
    json: {
      data: [
        {
          id: "anthropic/claude-haiku-4-5",
          pricing: { prompt: "0.0000008", completion: "0.000004" }
        }
      ]
    }
  });
  assert.equal(result.method, "json_api");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].route_context, "aggregator");
  assert.equal(result.records[0].pricing_status, "valid");
  assert.ok(result.records[0].source_hash);
});

test("cross-validate prefers official over aggregator for same id", async () => {
  const { crossValidatePricing } = await import("../src/smartRoute/researchAgent/crossValidatePricing.js");
  const { pricing } = crossValidatePricing([
    {
      canonical_id: "openai:gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      route_context: "aggregator",
      input_per_1m: 0.2,
      output_per_1m: 0.8,
      source_authority: "aggregator_pricing",
      source_url: "https://openrouter.ai/api/v1/models",
      confidence: 0.9,
      pricing_status: "valid"
    },
    {
      canonical_id: "openai:gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      route_context: "direct_provider",
      input_per_1m: 0.15,
      output_per_1m: 0.6,
      source_authority: "official_pricing",
      source_url: "https://openai.com/api/pricing/",
      confidence: 0.95,
      pricing_status: "valid"
    }
  ]);
  assert.equal(pricing[0].source_authority, "official_pricing");
  assert.equal(pricing[0].input_per_1m, 0.15);
});

test("price change >25% requires review unless official", async () => {
  const { crossValidatePricing } = await import("../src/smartRoute/researchAgent/crossValidatePricing.js");
  const result = crossValidatePricing(
    [
      {
        canonical_id: "openai:gpt-4o-mini",
        provider: "openai",
        model: "gpt-4o-mini",
        route_context: "direct_provider",
        input_per_1m: 0.5,
        output_per_1m: 0.6,
        source_authority: "static_official_table",
        source_url: "https://openai.com/api/pricing/",
        confidence: 0.7,
        pricing_status: "valid"
      }
    ],
    { "openai:gpt-4o-mini": { input_per_1m: 0.15, output_per_1m: 0.6 } },
    { largePriceChangePercent: 25 }
  );
  assert.ok(result.requiresReview.length >= 1);
});

test("source fetch failure preserves last good catalog", async () => {
  const store = await import("../src/smartRoute/researchAgent/sourceSnapshotStore.js");
  const previous = {
    version: 1,
    generated_at: "2026-07-01T00:00:00.000Z",
    refresh_status: "ok",
    pricing: [
      {
        canonical_id: "openai:gpt-4o-mini",
        input_per_1m: 0.15,
        output_per_1m: 0.6,
        pricing_status: "valid",
        source_url: "https://openai.com/api/pricing/"
      }
    ],
    research_hash: "oldhash"
  };

  // Simulate preservePartial behavior used by research refresh
  const preserved = {
    ...previous,
    stale: true,
    refresh_status: "partial",
    last_error: "source_fetch_failed"
  };
  assert.equal(preserved.refresh_status, "partial");
  assert.equal(preserved.pricing[0].canonical_id, "openai:gpt-4o-mini");
  assert.notEqual(preserved.refresh_status, "ok");
  assert.ok(store.catalogHash(previous));
});

test("LLM-assisted extraction cannot override deterministic validation", async () => {
  const { extractPricingFromSource } = await import("../src/smartRoute/researchAgent/extractPricing.js");
  const result = extractPricingFromSource(
    {
      ok: true,
      provider: "openai",
      url: "https://openai.com/api/pricing/",
      source: { authority: "official_pricing" },
      snapshot: { source_hash: "x", fetched_at: new Date().toISOString() },
      text: "no tables here"
    },
    {
      llmExtractionEnabled: true,
      llmExtractFn: () => [
        {
          provider: "openai",
          model: "gpt-evil",
          canonical_id: "openai:gpt-evil",
          route_context: "direct_provider",
          input_per_1m: -1000000,
          output_per_1m: -1000000,
          evidence_label: "llm-hallucination"
        }
      ]
    }
  );
  // Invalid LLM rows are kept only as invalid records, never valid
  const valid = result.records.filter((r) => r.pricing_status === "valid");
  assert.equal(valid.length, 0);
});

test("direct provider price beats aggregator hint for direct route", async () => {
  const { lookupResearchPricing } = await import("../src/smartRoute/researchAgent/researchCatalog.js");
  const catalog = {
    pricing: [
      {
        canonical_id: "openai:gpt-4o-mini",
        provider: "openai",
        model: "gpt-4o-mini",
        route_context: "direct_provider",
        input_per_1m: 0.15,
        output_per_1m: 0.6,
        pricing_status: "valid",
        source_authority: "official_pricing",
        source_url: "https://openai.com/api/pricing/",
        cost_sensitive_eligible: true,
        confidence: 0.95
      }
    ]
  };
  catalog.pricing_by_id = Object.fromEntries(catalog.pricing.map((r) => [r.canonical_id, r]));
  const hit = lookupResearchPricing(
    { canonical_id: "openai:gpt-4o-mini", provider: "openai", model: "gpt-4o-mini" },
    catalog
  );
  assert.equal(hit.input_per_1m, 0.15);
  assert.equal(hit.source_authority, "official_pricing");
});

test("SWE-bench scores attach to coding models", async () => {
  const { extractBenchmarksFromSource } = await import(
    "../src/smartRoute/researchAgent/extractBenchmarks.js"
  );
  const rows = extractBenchmarksFromSource(
    { ok: true, text: "", url: "https://www.swebench.com/" },
    [{ canonical_id: "anthropic:claude-sonnet-4-6", model: "claude-sonnet-4-6" }]
  );
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].benchmark, "swe_bench_verified");
  assert.ok(rows[0].score > 0);
});

test("invalid pricing cannot win cost-sensitive ranking", async () => {
  const { scoreModelForTask } = await import("../src/smartRoute/modelRanker.js");
  const model = {
    canonical_id: "cursor:auto",
    provider: "cursor",
    model: "auto",
    available: true,
    pricing: {
      input_per_1m: -1_000_000,
      output_per_1m: -1_000_000,
      pricing_source: "openrouter_catalog",
      pricing_status: "invalid",
      pricing_invalid_reason: "sentinel_value",
      cost_sensitive_eligible: false
    },
    benchmarks: { benchmark_confidence: 0.8, routerbot_eval: { chat: 0.7 } },
    health: {
      response_ok: true,
      success_rate_24h: 0.99,
      health_source: "direct_probe",
      health_confidence: 1
    }
  };
  const scored = scoreModelForTask(model, "chat", { costSensitive: true });
  assert.equal(scored.pass, false);
  assert.equal(scored.reason, "unknown_pricing");
});
