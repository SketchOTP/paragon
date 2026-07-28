import assert from "node:assert/strict";
import test from "node:test";
import { parseModels } from "../src/cli.js";
import {
  CLAUDE_DOCUMENTED_MODELS,
  discoverClaudeModels,
  loadClaudeBundledCatalog,
  parseClaudeModelListOutput
} from "../src/claudeModels.js";
import { loadCodexBundledCatalog } from "../src/codexModels.js";
import { alignProviderModel, parseCodexModelsCatalog } from "../src/modelList.js";
import { openAiBaseUrl } from "../src/httpProvider.js";

test("openAiBaseUrl appends /v1 when missing", () => {
  assert.equal(openAiBaseUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1");
  assert.equal(openAiBaseUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(openAiBaseUrl("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1");
});

test("alignProviderModel clears stale selection not in provider list", () => {
  const providerConfig = { model: "fake-model" };
  const models = [{ id: "gpt-5.3-codex", name: "Codex 5.3" }];
  const aligned = alignProviderModel(providerConfig, models);
  assert.deepEqual(aligned, models);
  assert.equal(providerConfig.model, "");
});

test("alignProviderModel does not inject synthetic models", () => {
  const providerConfig = { model: "real" };
  const aligned = alignProviderModel(providerConfig, [{ id: "other", name: "Other" }]);
  assert.equal(aligned.length, 1);
  assert.equal(providerConfig.model, "");
});

test("parseCodexModelsCatalog reads slug entries", () => {
  const models = parseCodexModelsCatalog(
    JSON.stringify([
      { slug: "gpt-5.3-codex", display_name: "Codex 5.3" },
      { slug: "gpt-5.4", display_name: "GPT-5.4" }
    ])
  );
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "gpt-5.3-codex");
});

test("parseModels parses cursor-agent models output", () => {
  const stdout = `Available models

auto - Auto (current)
gpt-5.3-codex - Codex 5.3
composer-2.5 - Composer 2.5`;
  const models = parseModels("cursor", stdout);
  assert.deepEqual(
    models.map((model) => model.id),
    ["auto", "gpt-5.3-codex", "composer-2.5"]
  );
});

test("discoverClaudeModels includes documented Opus 4.8", async () => {
  const models = await discoverClaudeModels("claude");
  if (!models.length) {
    return;
  }
  assert.ok(models.some((model) => model.id === "claude-opus-4-8"), "expected claude-opus-4-8");
});

test("loadClaudeBundledCatalog reads model ids from installed binary when present", () => {
  const models = loadClaudeBundledCatalog("claude");
  if (!models.length) {
    return;
  }
  assert.ok(models.some((model) => model.id.startsWith("claude-sonnet-4")));
});

test("CLAUDE_DOCUMENTED_MODELS includes the current model family names (opus/sonnet/fable/mythos 5)", () => {
  // Regression guard: the discovery regex/id-filter must recognize these
  // family names, not just opus/sonnet/haiku — this is the exact bug that
  // made the dashboard's model list stale after Fable 5/Mythos 5 shipped.
  for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
    assert.ok(CLAUDE_DOCUMENTED_MODELS.some((model) => model.id === id), `expected ${id} in the documented floor list`);
  }
});

test("parseClaudeModelListOutput recognizes fable/mythos ids, not just opus/sonnet/haiku", () => {
  const models = parseClaudeModelListOutput("claude-fable-5\nclaude-mythos-5\nclaude-opus-5");
  assert.deepEqual(
    models.map((m) => m.id).sort(),
    ["claude-fable-5", "claude-mythos-5", "claude-opus-5"]
  );
});

test("loadClaudeBundledCatalog picks up fable/mythos strings from the installed binary when present", () => {
  const models = loadClaudeBundledCatalog("claude");
  if (!models.length) {
    return;
  }
  const ids = models.map((m) => m.id);
  // Only assert if the installed binary is new enough to contain these —
  // don't turn this into a change-detector against a specific CLI version.
  const hasFableFamily = ids.some((id) => id.startsWith("claude-fable-") || id.startsWith("claude-mythos-"));
  if (hasFableFamily) {
    assert.ok(ids.includes("claude-fable-5"));
  }
});

test("loadCodexBundledCatalog returns slugs from installed binary when present", () => {
  const models = loadCodexBundledCatalog("codex");
  if (!models.length) {
    return;
  }
  assert.ok(models.some((model) => model.id.includes("codex") || model.id.startsWith("gpt-")));
});
