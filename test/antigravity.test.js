import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAntigravityPrintCommand,
  checkAntigravityAuthStatus,
  invalidateAntigravityAuthCache,
  shellSingleQuote
} from "../src/antigravityModels.js";
import { migrateGeminiToAntigravity } from "../src/configMigrate.js";
import { defaultConfig } from "../src/defaultConfig.js";

test("shellSingleQuote escapes single quotes", () => {
  assert.equal(shellSingleQuote("it's"), `'it'\\''s'`);
});

test("buildAntigravityPrintCommand uses agy -p", () => {
  const cmd = buildAntigravityPrintCommand("agy", "hello", "gemini-3.5-flash");
  assert.match(cmd, /agy -p 'hello' --model 'gemini-3\.5-flash'/);
});

test("antigravity oauth auth uses print mode not interactive TUI", async () => {
  const { defaultConfig } = await import("../src/defaultConfig.js");
  const { getProviderSpec } = await import("../src/cli.js");
  const spec = getProviderSpec("antigravity", defaultConfig.providers.antigravity);
  assert.deepEqual(spec.authArgs, ["-p", "Reply with exactly: ok"]);
});

test("checkAntigravityAuthStatus reports missing binary", () => {
  const result = checkAntigravityAuthStatus("__missing_agy_binary__");
  assert.equal(result.ok, false);
  assert.match(result.output, /not found/i);
});

test("checkAntigravityAuthStatus detects signed-in catalog names", () => {
  invalidateAntigravityAuthCache();
  const live = checkAntigravityAuthStatus("agy");
  assert.equal(live.ok, true, live.output);
});

test("migrateGeminiToAntigravity replaces routing slots", () => {
  const config = {
    providers: {
      gemini: { enabled: true, model: "gemini-2.5-flash", models: [] },
      claude: { enabled: true }
    },
    routing: {
      fallbackChain: ["codex", "gemini"],
      taskRoutes: { explain: "gemini", docs: "gemini" }
    }
  };
  const migrated = migrateGeminiToAntigravity({ ...defaultConfig, ...config });
  assert.equal(migrated.providers.gemini, undefined);
  assert.equal(migrated.providers.antigravity.enabled, true);
  assert.deepEqual(migrated.routing.fallbackChain, ["codex", "antigravity"]);
  assert.equal(migrated.routing.taskRoutes.explain, "antigravity");
});
