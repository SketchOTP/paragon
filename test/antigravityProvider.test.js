import assert from "node:assert/strict";
import test from "node:test";

import { getProviderSpec, parseModels } from "../src/cli.js";
import { BUILTIN_PROVIDERS, defaultConfig } from "../src/defaultConfig.js";

test("gemini is fully removed — EOL, confirmed via IneligibleTierError from the installed @google/gemini-cli itself", () => {
  assert.ok(!BUILTIN_PROVIDERS.includes("gemini"));
  assert.equal(defaultConfig.providers.gemini, undefined);
});

test("antigravity is registered as a builtin provider, disabled by default", () => {
  assert.ok(BUILTIN_PROVIDERS.includes("antigravity"));
  const provider = defaultConfig.providers.antigravity;
  assert.ok(provider, "defaultConfig must define an antigravity provider entry");
  assert.equal(provider.type, "builtin");
  assert.equal(provider.command, "agy");
  assert.equal(provider.enabled, false, "must ship disabled — requires --dangerously-skip-permissions to produce output");
  assert.equal(provider.stdinMode, "none", "the prompt is passed as a --print argument, not via stdin");
});

test("antigravity runArgs embeds the prompt as a direct --print argument, not left to stdin", () => {
  const spec = getProviderSpec("antigravity", defaultConfig.providers.antigravity);
  const args = spec.runArgs({ model: "gemini-3.1-pro-high", prompt: "hello world" });

  const printIndex = args.indexOf("--print");
  assert.ok(printIndex >= 0);
  assert.equal(args[printIndex + 1], "hello world", "the prompt must be the value immediately after --print");
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.1-pro-high");
});

test("antigravity runArgs tolerates a missing prompt without throwing", () => {
  const spec = getProviderSpec("antigravity", defaultConfig.providers.antigravity);
  assert.doesNotThrow(() => spec.runArgs({ model: "" }));
});

test("parseModels falls back to one-model-per-line for antigravity's plain-text model list", () => {
  const stdout = "gemini-3.6-flash-high\ngemini-3.1-pro-high\nclaude-sonnet-4-6\n";
  const models = parseModels("antigravity", stdout);
  assert.deepEqual(models, [
    { id: "gemini-3.6-flash-high", name: "gemini-3.6-flash-high" },
    { id: "gemini-3.1-pro-high", name: "gemini-3.1-pro-high" },
    { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }
  ]);
});
