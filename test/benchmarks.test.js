import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeModelKey,
  matchBenchmarkRow,
  annotateRegistryWithBenchmarks,
  getBenchmarkData,
  resetBenchmarkCacheForTests
} from "../src/routing/benchmarks.js";

test.beforeEach(() => {
  resetBenchmarkCacheForTests();
});

test("normalizeModelKey strips reasoning-effort/variant suffixes and date stamps", () => {
  assert.equal(normalizeModelKey("claude-opus-4-8-thinking-high-fast"), "claudeopus48");
  assert.equal(normalizeModelKey("claude-opus-4-1-20250805-v1"), "claudeopus41");
  assert.equal(normalizeModelKey("gpt-5.6-sol-medium"), "gpt56sol");
});

test("matchBenchmarkRow finds a substring-containment match on normalized keys", () => {
  const rows = [
    { model_permaslug: "anthropic/claude-opus-4.8", display_name: "Claude Opus 4.8", intelligence_index: 55 },
    { model_permaslug: "openai/gpt-5.6", display_name: "GPT-5.6 Sol", intelligence_index: 59 }
  ];
  const match = matchBenchmarkRow("claude-opus-4-8-thinking-high", rows);
  assert.equal(match.model_permaslug, "anthropic/claude-opus-4.8");
});

test("matchBenchmarkRow returns null rather than guessing when nothing matches", () => {
  const rows = [{ model_permaslug: "openai/gpt-5.6", display_name: "GPT-5.6 Sol" }];
  assert.equal(matchBenchmarkRow("cursor-grok-4.5-high-fast", rows), null);
});

test("annotateRegistryWithBenchmarks leaves unmatched entries unchanged, never backfills a guess", () => {
  const registry = [{ provider: "claude", model: "claude-opus-4-8-high" }];
  const annotated = annotateRegistryWithBenchmarks(registry, []);
  assert.equal(annotated[0].externalBenchmark, undefined);
});

test("annotateRegistryWithBenchmarks attaches the matched row's real fields, source disclosed", () => {
  const registry = [{ provider: "claude", model: "claude-opus-4-8" }];
  const rows = [
    {
      source: "artificial-analysis",
      model_permaslug: "anthropic/claude-opus-4.8",
      display_name: "Claude Opus 4.8",
      intelligence_index: 55,
      coding_index: 60,
      pricing: { prompt: "0.000015", completion: "0.000075" }
    }
  ];
  const annotated = annotateRegistryWithBenchmarks(registry, rows);
  assert.equal(annotated[0].externalBenchmark.source, "artificial-analysis");
  assert.equal(annotated[0].externalBenchmark.intelligenceIndex, 55);
  assert.deepEqual(annotated[0].externalBenchmark.pricing, { prompt: "0.000015", completion: "0.000075" });
});

test("getBenchmarkData returns disabled when no API key is configured, without ever calling fetch", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error("must not be called");
  };
  try {
    const result = await getBenchmarkData("");
    assert.equal(result.enabled, false);
    assert.deepEqual(result.rows, []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getBenchmarkData surfaces a request failure without throwing, so a bad key never breaks the dashboard", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "invalid api key" });
  try {
    const result = await getBenchmarkData("bad-key");
    assert.equal(result.enabled, true);
    assert.match(result.error, /401/);
    assert.deepEqual(result.rows, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getBenchmarkData caches successful responses and does not refetch within the TTL", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return {
      ok: true,
      json: async () => ({ data: [{ source: "artificial-analysis", model_permaslug: "x/y" }], meta: { as_of: "now" } })
    };
  };
  try {
    const first = await getBenchmarkData("key-1");
    const second = await getBenchmarkData("key-1");
    assert.equal(callCount, 1, "second call within TTL must be served from cache");
    assert.equal(first.rows.length, 1);
    assert.deepEqual(second.rows, first.rows);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getBenchmarkData refetches when the API key changes", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return { ok: true, json: async () => ({ data: [], meta: {} }) };
  };
  try {
    await getBenchmarkData("key-1");
    await getBenchmarkData("key-2");
    assert.equal(callCount, 2, "a changed key must trigger a fresh fetch, not reuse the other key's cache");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
