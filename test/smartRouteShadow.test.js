import assert from "node:assert/strict";
import test from "node:test";
import { recordShadowRoutingDecision } from "../src/smartRouteShadow.js";
import { readRecentDecisions } from "../src/smartRoute/decisionLog.js";
import { defaultConfig } from "../src/defaultConfig.js";
import { withIsolatedDataDir } from "./helpers/isolatedDataDir.js";

function baseConfig(overrides = {}) {
  return {
    ...defaultConfig,
    providers: {
      codex: { ...defaultConfig.providers.codex, enabled: true },
      antigravity: { ...defaultConfig.providers.antigravity, enabled: true },
      claude: { ...defaultConfig.providers.claude, enabled: true }
    },
    routing: {
      ...defaultConfig.routing,
      smartRoute: { ...defaultConfig.routing.smartRoute, ...overrides }
    }
  };
}

test("legacy mode never evaluates or logs a shadow decision", async () => {
  await withIsolatedDataDir(async () => {
    const config = baseConfig({ mode: "legacy" });
    const result = await recordShadowRoutingDecision({
      body: { model: "paragon", messages: [{ role: "user", content: "hi" }] },
      headers: {},
      config,
      legacyTask: "code",
      legacyProvider: "codex"
    });
    assert.equal(result, null);
    const decisions = await readRecentDecisions(10);
    assert.equal(decisions.length, 0);
  });
});

test("shadow_test mode logs a decision without throwing, tagged with the legacy pick", async () => {
  await withIsolatedDataDir(async () => {
    const config = baseConfig({ mode: "shadow_test" });
    const entry = await recordShadowRoutingDecision({
      body: { model: "paragon", messages: [{ role: "user", content: "hi" }] },
      headers: {},
      config,
      legacyTask: "code",
      legacyProvider: "codex"
    });
    assert.ok(entry);
    assert.equal(entry.legacy_provider, "codex");
    assert.equal(entry.legacy_task, "code");
    assert.equal(entry.mode, "shadow_test");
    assert.ok("shadow_match" in entry);
  });
});

test("a broken smartRoute config never throws out of recordShadowRoutingDecision", async () => {
  await withIsolatedDataDir(async () => {
    const config = baseConfig({ mode: "shadow_test" });
    // Malformed request body that could plausibly break normalization/classification.
    await assert.doesNotReject(
      recordShadowRoutingDecision({
        body: null,
        headers: {},
        config,
        legacyTask: "code",
        legacyProvider: "codex"
      })
    );
  });
});
