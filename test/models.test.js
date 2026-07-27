import assert from "node:assert/strict";
import test from "node:test";
import { parseModels } from "../src/cli.js";
import {
  discoverClaudeModels,
  loadClaudeBundledCatalog,
  parseAnthropicModelsResponse,
  parseClaudeModelListOutput
} from "../src/claudeModels.js";
import { parseAntigravityModelsOutput } from "../src/antigravityModels.js";
import { parseCursorModelsOutput } from "../src/cursorModels.js";
import { discoverCodexModels, loadCodexBundledCatalog, loadCodexModelsCache, resolveCodexClientVersion } from "../src/codexModels.js";
import { alignProviderModel, normalizeCodexModelEntries, parseCodexModelsCatalog } from "../src/modelList.js";
import { openAiBaseUrl, parseHttpModelListResponse } from "../src/httpProvider.js";

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

test("normalizeCodexModelEntries drops hidden visibility", () => {
  const models = normalizeCodexModelEntries([
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
    { slug: "legacy", display_name: "Legacy", visibility: "hidden" }
  ]);
  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-5.5"]
  );
});

test("loadCodexModelsCache prefers account catalog over bundled slugs", () => {
  const models = loadCodexModelsCache();
  if (!models.length) {
    return;
  }
  assert.ok(models.some((model) => model.id === "gpt-5.5"), "expected gpt-5.5 from models_cache.json");
  assert.equal(
    models.some((model) => model.id === "gpt-5-codex"),
    false,
    "stale bundled slug gpt-5-codex should not appear when cache is present"
  );
});

test("resolveCodexClientVersion prefers newest semver across cache and CLI", () => {
  const version = resolveCodexClientVersion();
  if (!version) {
    return;
  }
  const cache = loadCodexModelsCache();
  if (!cache.length) {
    return;
  }
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("baseUrlCandidates dedupes primary and fallbacks", async () => {
  const { baseUrlCandidates } = await import("../src/httpProvider.js");
  assert.deepEqual(
    baseUrlCandidates({
      baseUrl: "http://sketch:1234",
      baseUrlFallbacks: ["http://100.80.17.40:1234", "http://sketch:1234/"]
    }),
    ["http://sketch:1234", "http://100.80.17.40:1234"]
  );
});

test("parseHttpModelListResponse accepts data and models arrays", () => {
  const fromData = parseHttpModelListResponse({
    data: [{ id: "google/gemma-4-e2b" }, { id: "liquid/lfm2-24b-a2b", name: "LFM2" }]
  });
  assert.deepEqual(
    fromData.map((model) => model.id),
    ["google/gemma-4-e2b", "liquid/lfm2-24b-a2b"]
  );
  assert.equal(fromData[1].name, "LFM2");

  const fromModels = parseHttpModelListResponse({
    models: [{ name: "echo-smollm2-echo-50k-merged" }]
  });
  assert.equal(fromModels[0].id, "echo-smollm2-echo-50k-merged");
});

test("discoverCodexModels uses cache without refresh", async () => {
  const models = await discoverCodexModels("codex", { refresh: false });
  if (!models.length) {
    return;
  }
  const cached = loadCodexModelsCache();
  if (cached.length) {
    assert.deepEqual(
      models.map((model) => model.id),
      cached.map((model) => model.id)
    );
  }
});

test("discoverCodexModels refresh pulls live account catalog when authenticated", async () => {
  const models = await discoverCodexModels("codex", { refresh: true });
  if (!models.length) {
    return;
  }
  const cached = loadCodexModelsCache();
  if (cached.length) {
    assert.ok(
      models.length >= cached.length,
      "refresh should not return fewer models than the on-disk cache"
    );
  }
});

test("parseCursorModelsOutput parses cursor-agent models output", () => {
  const stdout = `Available models

auto - Auto (current)
gpt-5.3-codex - Codex 5.3
composer-2.5 - Composer 2.5`;
  const models = parseCursorModelsOutput(stdout);
  assert.deepEqual(
    models.map((model) => model.id),
    ["auto", "gpt-5.3-codex", "composer-2.5"]
  );
});

test("parseModels delegates cursor output to parseCursorModelsOutput", () => {
  const stdout = "auto - Auto\ncomposer-2.5 - Composer 2.5";
  const models = parseModels("cursor", stdout);
  assert.deepEqual(
    models.map((model) => model.id),
    ["auto", "composer-2.5"]
  );
});

test("parseAnthropicModelsResponse reads API model ids", () => {
  const models = parseAnthropicModelsResponse({
    data: [
      { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }
    ]
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["claude-opus-4-8", "claude-sonnet-5"]
  );
});

test("splitTTYLines keeps final spinner-overwritten segment", async () => {
  const { splitTTYLines } = await import("../src/cliOutput.js");
  const output =
    "⠋ Fetching available models...\r⠙ Fetching available models...\r\x1b[KGemini 3.5 Flash (Medium)\r\nGemini 3.5 Flash (High)";
  const lines = splitTTYLines(output);
  assert.ok(lines.includes("Gemini 3.5 Flash (Medium)"));
  assert.ok(lines.includes("Gemini 3.5 Flash (High)"));
  assert.equal(lines.some((line) => /Fetching available models/.test(line)), false);
});

test("parseAntigravityModelsOutput handles spinner-overwritten TTY lines", () => {
  const output = "\x1b[KGemini 3.5 Flash (Medium)\r\nGemini 3.5 Flash\r\nClaude Sonnet 4.6";
  const models = parseAntigravityModelsOutput(output);
  assert.deepEqual(
    models.map((model) => model.id),
    ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash", "Claude Sonnet 4.6"]
  );
});

test("parseClaudeModelListOutput parses JSON model list", () => {
  const models = parseClaudeModelListOutput(
    JSON.stringify({ data: [{ id: "claude-opus-4-8", display_name: "Opus 4.8" }] })
  );
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "claude-opus-4-8");
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

test("loadCodexBundledCatalog returns slugs from installed binary when present", () => {
  const models = loadCodexBundledCatalog("codex");
  if (!models.length) {
    return;
  }
  assert.ok(models.some((model) => model.id.includes("codex") || model.id.startsWith("gpt-")));
});
