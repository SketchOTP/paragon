import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalModelKey,
  dateStrippedModelKey,
  matchBenchmarkRow,
  annotateRegistryWithBenchmarks,
  getBenchmarkData,
  resetBenchmarkCacheForTests,
  seedBenchmarkCacheForTests,
  benchmarkCacheStateForTests,
  MAX_USABLE_AGE_MS
} from "../src/routing/benchmarks.js";

test.beforeEach(() => {
  resetBenchmarkCacheForTests();
});

test("canonicalModelKey preserves version and variant information (that stripping is what caused cross-version collisions)", () => {
  assert.equal(canonicalModelKey("claude-opus-4-8-thinking-high"), "claudeopus48thinkinghigh");
  assert.equal(canonicalModelKey("anthropic/claude-4.7-opus-20260416"), "claude47opus20260416");
  assert.notEqual(canonicalModelKey("claude-opus-4"), canonicalModelKey("claude-opus-4-7"));
});

test("dateStrippedModelKey removes only a trailing release-date snapshot", () => {
  assert.equal(dateStrippedModelKey("claude-opus-4-20250514"), "claudeopus4");
  assert.equal(dateStrippedModelKey("claude-opus-4-1-20250805-v1"), "claudeopus41");
  assert.equal(dateStrippedModelKey("claude-opus-4-6-thinking"), "claudeopus46thinking", "variant suffixes must survive");
});

test("matchBenchmarkRow makes an exact canonical match", () => {
  const rows = [
    { model_permaslug: "anthropic/claude-opus-4.8", display_name: "Claude Opus 4.8", intelligence_index: 55 },
    { model_permaslug: "openai/gpt-5.6", display_name: "GPT-5.6 Sol", intelligence_index: 59 }
  ];
  const match = matchBenchmarkRow("claude-opus-4-8", rows);
  assert.equal(match.row.model_permaslug, "anthropic/claude-opus-4.8");
  assert.equal(match.matchMethod, "exact");
  assert.equal(match.matchConfidence, "high");
});

test("matchBenchmarkRow matches a dated snapshot to its own undated display name", () => {
  const rows = [
    { model_permaslug: "anthropic/claude-4-opus-20250522", display_name: "Claude Opus 4", coding_index: 40 },
    { model_permaslug: "anthropic/claude-4.7-opus-20260416", display_name: "Claude Opus 4.7", coding_index: 73.6 }
  ];
  const match = matchBenchmarkRow("claude-opus-4-20250514", rows);
  assert.equal(match.matchMethod, "exact_normalized");
  assert.equal(match.row.display_name, "Claude Opus 4");
});

// The confirmed production defect this hotfix exists for: substring
// containment plus a "prefer the longest match" tiebreak made
// claude-opus-4 inherit Claude Opus 4.7's coding index (73.6) and price
// ($5.50/M), discarding the exact Claude Opus 4 row that was present.
test("Claude Opus 4 must not inherit Claude Opus 4.7 benchmark data (regression: prefix-containment collision)", () => {
  const rows = [
    {
      model_permaslug: "anthropic/claude-4.7-opus-20260416",
      display_name: "Claude Opus 4.7",
      coding_index: 73.6,
      pricing: { prompt: "0.0000055" }
    },
    {
      model_permaslug: "anthropic/claude-4.8-opus-20260528",
      display_name: "Claude Opus 4.8",
      coding_index: 78,
      pricing: { prompt: "0.000006" }
    }
  ];
  // No Opus 4 row present at all -> must be no match, not the nearest name.
  assert.equal(matchBenchmarkRow("claude-opus-4-20250514", rows), null);

  // With the correct row present, it must win over the 4.7/4.8 prefixes.
  const withCorrect = [
    ...rows,
    { model_permaslug: "anthropic/claude-4-opus-20250522", display_name: "Claude Opus 4", coding_index: 40, pricing: { prompt: "0.000015" } }
  ];
  const match = matchBenchmarkRow("claude-opus-4-20250514", withCorrect);
  assert.equal(match.row.coding_index, 40);
  assert.notEqual(match.row.coding_index, 73.6);
});

test("matchBenchmarkRow rejects substring/prefix containment outright", () => {
  const rows = [{ model_permaslug: "openai/gpt-5.6-sol", display_name: "GPT-5.6 Sol" }];
  assert.equal(matchBenchmarkRow("gpt-5", rows), null, "a shorter prefix must not match a longer id");
  assert.equal(matchBenchmarkRow("gpt-5.6-sol-medium", rows), null, "a decorated variant must not match the base row");
});

test("matchBenchmarkRow does not let a reasoning variant inherit its base model's record", () => {
  const rows = [{ model_permaslug: "anthropic/claude-4.6-opus-20260205", display_name: "Claude Opus 4.6", coding_index: 70 }];
  assert.equal(matchBenchmarkRow("claude-opus-4-6-thinking", rows), null);
});

test("matchBenchmarkRow returns null rather than guessing when nothing matches", () => {
  const rows = [{ model_permaslug: "openai/gpt-5.6", display_name: "GPT-5.6 Sol" }];
  assert.equal(matchBenchmarkRow("cursor-grok-4.5-high-fast", rows), null);
});

test("matchBenchmarkRow honors an explicit reviewed alias only when one is registered", async () => {
  const mod = await import("../src/routing/benchmarks.js");
  // The shipped alias table is intentionally empty — an alias is a human
  // assertion, never inferred. Assert the contract, not a specific entry.
  assert.deepEqual(mod.EXPLICIT_BENCHMARK_ALIASES, {});
});

test("annotateRegistryWithBenchmarks leaves unmatched entries unchanged, never backfills a guess", () => {
  const registry = [{ provider: "claude", model: "claude-opus-4-8-high" }];
  const annotated = annotateRegistryWithBenchmarks(registry, []);
  assert.equal(annotated[0].externalBenchmark, undefined);
});

test("annotateRegistryWithBenchmarks records full attribution for a match", () => {
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
  const annotated = annotateRegistryWithBenchmarks(registry, rows, { fetchedAt: "2026-07-29T00:00:00.000Z" });
  const bm = annotated[0].externalBenchmark;
  assert.equal(bm.source, "artificial-analysis");
  assert.equal(bm.intelligenceIndex, 55);
  assert.equal(bm.matchMethod, "exact");
  assert.equal(bm.matchConfidence, "high");
  assert.equal(bm.matchedLocalModel, "claude-opus-4-8");
  assert.equal(bm.matchedBenchmarkModel, "anthropic/claude-opus-4.8");
  assert.equal(bm.benchmarkFetchedAt, "2026-07-29T00:00:00.000Z");
  assert.deepEqual(bm.pricing, { prompt: "0.000015", completion: "0.000075" });
});

test("annotateRegistryWithBenchmarks skips entries with no resolved model (e.g. pending_assessment rows)", () => {
  const annotated = annotateRegistryWithBenchmarks([{ provider: "lmstudio", model: null }], [{ model_permaslug: "x/y" }]);
  assert.equal(annotated[0].externalBenchmark, undefined);
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
    assert.equal(result.stale, true);
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

test("getBenchmarkData caches successful responses and does not refetch within the attempt interval", async () => {
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
    assert.equal(callCount, 1, "second call within the attempt interval must be served from cache");
    assert.equal(first.rows.length, 1);
    assert.deepEqual(second.rows, first.rows);
    assert.equal(first.stale, false);
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

// P0-7 regressions: the old cache set `at: Date.now()` in the failure
// branch while keeping the old payload, so each failure bought another full
// TTL of stale scores and `cachedAt` reported the failure time as if data
// had just been fetched.
test("a failed refresh does not advance lastSuccessfulFetchAt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ model_permaslug: "x/y" }], meta: {} }) });
  try {
    await getBenchmarkData("key-1");

    // Pin the successful fetch to a known, distinctly older instant so the
    // assertion can't be defeated by both events landing in the same
    // millisecond, and make the next attempt due.
    const successMs = Date.now() - 60_000;
    seedBenchmarkCacheForTests({ lastSuccessfulFetchAt: successMs, lastAttemptAt: 0 });
    const successAt = new Date(successMs).toISOString();

    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const failed = await getBenchmarkData("key-1");
    assert.equal(failed.lastSuccessfulFetchAt, successAt, "successful-fetch timestamp must be preserved across a failure");
    assert.ok(
      Date.parse(failed.lastAttemptAt) > successMs,
      "attempt timestamp must advance past the last successful fetch"
    );
    assert.match(failed.error, /network down/);
    assert.equal(failed.rows.length, 1, "previous payload stays visible for diagnostics");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repeated failures cannot indefinitely refresh stale benchmark data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ model_permaslug: "x/y" }], meta: {} }) });
  try {
    await getBenchmarkData("key-1");
    // Pretend the successful fetch happened well beyond the usable age.
    const longAgo = Date.now() - (MAX_USABLE_AGE_MS + 60_000);
    seedBenchmarkCacheForTests({ lastSuccessfulFetchAt: longAgo, lastAttemptAt: 0 });
    globalThis.fetch = async () => {
      throw new Error("still down");
    };
    for (let i = 0; i < 3; i += 1) {
      seedBenchmarkCacheForTests({ lastAttemptAt: 0 });
      const result = await getBenchmarkData("key-1");
      assert.equal(result.stale, true, "data past max usable age must stay stale no matter how many attempts fail");
    }
    assert.equal(benchmarkCacheStateForTests().lastSuccessfulFetchAt, longAgo);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("benchmark data older than the maximum usable age is reported stale so callers withhold it from scoring", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ model_permaslug: "x/y" }], meta: {} }) });
  try {
    const fresh = await getBenchmarkData("key-1");
    assert.equal(fresh.stale, false);
    assert.ok(fresh.dataAgeMs < MAX_USABLE_AGE_MS);

    seedBenchmarkCacheForTests({ lastSuccessfulFetchAt: Date.now() - (MAX_USABLE_AGE_MS + 1000) });
    const stale = await getBenchmarkData("key-1");
    assert.equal(stale.stale, true);
    assert.ok(stale.rows.length, "rows remain visible for diagnostics even when not applied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
