import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRegistry } from "../src/routing/modelRegistry.js";

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

test("buildModelRegistry marks every provider automaticEligibility true, unrestricted risk (auto-approve tool execution is a uniform policy, not antigravity-specific)", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  const antigravity = registry.find((e) => e.provider === "antigravity");
  assert.equal(antigravity.automaticEligibility, true);
  assert.equal(antigravity.toolExecutionRisk, "unrestricted");
});

test("buildModelRegistry applies the same eligibility/risk labeling to non-antigravity providers", () => {
  const registry = buildModelRegistry(baseConfig(), {});
  const claude = registry.find((e) => e.provider === "claude" && e.model === "claude-opus-5");
  assert.equal(claude.automaticEligibility, true);
  assert.equal(claude.toolExecutionRisk, "unrestricted");
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
