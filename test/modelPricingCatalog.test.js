import assert from "node:assert/strict";
import test from "node:test";

test("buildCatalogIndex indexes OpenRouter model ids and slugs", async () => {
  const { buildCatalogIndex } = await import("../src/smartRoute/modelPricingCatalog.js");
  const index = buildCatalogIndex([
    {
      id: "anthropic/claude-haiku-4-5",
      pricing: { prompt: "0.0000008", completion: "0.000004" }
    },
    {
      id: "openai/gpt-5.4",
      pricing: { prompt: "0.0000025", completion: "0.000015" }
    }
  ]);

  assert.equal(index.byId.size, 2);
  assert.equal(index.bySlug.get("claude-haiku-4-5")?.openrouter_id, "anthropic/claude-haiku-4-5");
  assert.equal(index.byId.get("openai/gpt-5.4")?.input_per_1m, 2.5);
});

test("lookupCatalogPricing resolves claude CLI model via catalog", async () => {
  const { buildCatalogIndex, lookupCatalogPricing } = await import(
    "../src/smartRoute/modelPricingCatalog.js"
  );
  const index = buildCatalogIndex([
    {
      id: "anthropic/claude-haiku-4-5",
      pricing: { prompt: "0.0000008", completion: "0.000004" }
    }
  ]);
  const row = {
    canonical_id: "claude:claude-haiku-4-5",
    provider: "claude",
    model: "claude-haiku-4-5"
  };
  const hit = lookupCatalogPricing(row, index);
  assert.equal(hit?.pricing_source, "openrouter_catalog");
  assert.ok(Math.abs(hit.input_per_1m - 0.8) < 0.001);
  assert.ok(Math.abs(hit.output_per_1m - 4) < 0.001);
});

test("lookupCatalogPricing resolves antigravity gemini display name", async () => {
  const { buildCatalogIndex, lookupCatalogPricing } = await import(
    "../src/smartRoute/modelPricingCatalog.js"
  );
  const index = buildCatalogIndex([
    {
      id: "google/gemini-2.5-flash",
      pricing: { prompt: "0.00000015", completion: "0.0000006" }
    }
  ]);
  const row = {
    canonical_id: "antigravity:Gemini 3.5 Flash (High)",
    provider: "antigravity",
    model: "Gemini 3.5 Flash (High)"
  };
  const hit = lookupCatalogPricing(row, index);
  assert.ok(hit);
  assert.equal(hit.pricing_source, "openrouter_catalog");
  assert.ok(hit.input_per_1m != null);
});

test("resolvePricing prefers catalog over subscription zero for cursor gpt models", async () => {
  const { resolvePricing } = await import("../src/smartRoute/modelPricing.js");
  const { buildCatalogIndex } = await import("../src/smartRoute/modelPricingCatalog.js");
  const catalog = buildCatalogIndex([
    {
      id: "openai/gpt-5.4",
      pricing: { prompt: "0.0000025", completion: "0.000015" }
    }
  ]);
  const row = {
    canonical_id: "cursor:gpt-5.4",
    provider: "cursor",
    model: "gpt-5.4"
  };
  const now = new Date().toISOString();
  const pricing = resolvePricing(row, {}, {}, {}, now, catalog);
  // Aggregator catalog is only a hint for CLI/subscription adapters.
  assert.equal(pricing.pricing_source, "aggregator_hint");
  assert.equal(pricing.input_per_1m, 2.5);
  assert.equal(pricing.cost_sensitive_eligible, false);
});

test("summarizePricingCoverage counts known vs unknown", async () => {
  const { summarizePricingCoverage } = await import("../src/smartRoute/modelPricingCatalog.js");
  const stats = summarizePricingCoverage([
    { pricing: { pricing_source: "openrouter_catalog", input_per_1m: 1 } },
    { pricing: { pricing_source: "unknown", input_per_1m: null } }
  ]);
  assert.equal(stats.total, 2);
  assert.equal(stats.known, 1);
  assert.equal(stats.unknown, 1);
  assert.equal(stats.known_rate, 0.5);
});
