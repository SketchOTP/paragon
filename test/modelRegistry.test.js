import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRegistry } from "../src/routing/modelRegistry.js";
import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";

function baseConfig(overrides = {}) {
  return {
    providers: {
      claude: {
        enabled: true,
        type: "builtin",
        model: "claude-opus-5",
        models: [
          { id: "claude-opus-5", name: "Opus 5" },
          { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" }
        ]
      },
      antigravity: {
        enabled: true,
        type: "builtin",
        model: "gemini-3.1-pro-high",
        models: [{ id: "gemini-3.1-pro-high", name: "gemini-3.1-pro-high" }]
      },
      disabled: {
        enabled: false,
        type: "builtin",
        model: "x",
        models: [{ id: "x", name: "x" }]
      },
      ...overrides
    }
  };
}

test("buildModelRegistry skips disabled providers", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  assert.ok(!registry.some((e) => e.provider === "disabled"));
});

test("buildModelRegistry produces one entry per discovered model, not one per provider", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  const claudeEntries = registry.filter((e) => e.provider === "claude");
  assert.equal(claudeEntries.length, 2);
  assert.ok(claudeEntries.some((e) => e.model === "claude-opus-5"));
  assert.ok(claudeEntries.some((e) => e.model === "claude-haiku-4-5-20251001"));
});

test("buildModelRegistry marks every provider automaticEligibility true, isolated risk (all providers run tools-disabled in a throwaway sandbox dir)", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  const antigravity = registry.find((e) => e.provider === "antigravity");
  assert.equal(antigravity.automaticEligibility, true);
  assert.equal(antigravity.toolExecutionRisk, "isolated");
});

test("buildModelRegistry applies the same eligibility/risk labeling to non-antigravity providers", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  const claude = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  assert.equal(claude.automaticEligibility, true);
  assert.equal(claude.toolExecutionRisk, "isolated");
});

test("buildModelRegistry infers a well-documented context window for claude, leaves unknowns null", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  const claude = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  assert.equal(claude.contextWindow, 200000);
  const antigravity = registry.find((e) => e.provider === "antigravity");
  assert.equal(antigravity.contextWindow, null, "unknown context windows must stay null, not fabricated");
});

test("buildModelRegistry reflects live health from the statuses snapshot without re-probing", () => {
  const registry = buildModelRegistry(baseConfig(), { claude: { ok: true }, antigravity: { ok: false } });
  assert.equal(registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5").health, "healthy");
  assert.equal(registry.find((e) => e.provider === "antigravity").health, "unhealthy");
});

test("buildModelRegistry cost class heuristic: haiku is economy, opus is premium", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  assert.equal(registry.find((e) => e.model === "claude-haiku-4-5-20251001").costClass, "economy");
  assert.equal(registry.find((e) => e.model === "claude-opus-5").costClass, "premium");
});

// PARAGON-D-004C: a supplied catalog gates eligibility for any provider it
// has actually assessed — a model sitting in providerConfig.models is no
// longer automatically eligible just because it's configured.

test("buildModelRegistry: a provider the catalog has never assessed still trusts providerConfig.models (freshly-added provider, before the first refresh)", () => {
  const catalog = defaultCatalog();
  const registry = buildModelRegistry(baseConfig(), {}, catalog);
  const claude = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  assert.equal(claude.automaticEligibility, true, "unassessed provider must not be dead on arrival");
});

test("buildModelRegistry: once the catalog has assessed a provider, only its exposed/validated entries are eligible — a rejected or unknown config-list entry is excluded from routing", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" },
    { modelId: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", state: "rejected", discoverySource: "documented_candidate" }
  ]);
  const registry = buildModelRegistry(baseConfig(), {}, catalog);
  const opus = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  const haiku = registry.find((e) => e.provider === "claude" && e.model === "claude-haiku-4-5-20251001");
  assert.equal(opus.automaticEligibility, true);
  assert.equal(haiku.automaticEligibility, false);
  assert.equal(haiku.modelState, "rejected");
});

test("buildModelRegistry: a validated entry past the configured TTL reads as ineligible", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(
    catalog,
    "claude",
    [{ modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" }],
    { now: new Date(Date.now() - 48 * 3_600_000).toISOString() }
  );
  const cfg = baseConfig();
  cfg.modelCatalog = { validationTtlHours: 24 };
  const registry = buildModelRegistry(cfg, {}, catalog);
  const opus = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  assert.equal(opus.automaticEligibility, false);
});
