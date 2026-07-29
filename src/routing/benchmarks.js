/**
 * Real external benchmark data (PARAGON-D-004 follow-up). OpenRouter's
 * /api/v1/benchmarks endpoint aggregates two independent, source-disclosed
 * benchmarks — Artificial Analysis (intelligence/coding/agentic indices)
 * and Design Arena (Elo/win-rate) — rather than OpenRouter's own opinion.
 * Verified against OpenRouter's published API docs before implementing
 * (GET https://openrouter.ai/api/v1/benchmarks, Bearer <api key>, JSON
 * shape confirmed 2026-07-28), not assumed.
 *
 * Requires an operator-supplied OpenRouter API key (config.integrations.
 * openrouterApiKey) — PARAGON never ships or fabricates one. Without a
 * key, everything here is skipped and the registry stays internal-only.
 *
 * PARAGON-D-004C1 (P0-6, P0-7) replaced two defects confirmed live in
 * production:
 *
 *  1. Matching was normalized *substring containment* with a "prefer the
 *     longest match" tiebreak. Because `claude-opus-4` normalizes to a
 *     prefix of `claude-opus-4.5/4.6/4.7/4.8`, the local id
 *     `claude-opus-4-20250514` matched 64 rows, and "longest wins"
 *     actively discarded the correct exact `Claude Opus 4` row in favour
 *     of `anthropic/claude-4.7-opus-20260416` — scoring a May-2025 model
 *     with an April-2026 model's coding index (73.6) and price ($5.50/M).
 *     Matching is now equality-only: containment, family inference, and
 *     nearest-name matching are gone.
 *  2. A failed refresh reset the cache timestamp while retaining the old
 *     payload, so every failure silently bought another full TTL of stale
 *     scores — indefinitely under sustained failure. Attempt time and
 *     successful-fetch time are now tracked separately, and data past
 *     MAX_USABLE_AGE_MS stops influencing routing entirely.
 */

const OPENROUTER_BENCHMARKS_URL = "https://openrouter.ai/api/v1/benchmarks";
/** How often to *attempt* a refresh. Keyed on attempts, not successes, so failures don't hot-loop. */
const ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Past this age since the last *successful* fetch, data is diagnostic-only and never influences routing. */
export const MAX_USABLE_AGE_MS = 24 * 60 * 60 * 1000;

let cache = {
  lastAttemptAt: 0,
  lastSuccessfulFetchAt: 0,
  data: null,
  error: null,
  apiKeyUsed: null
};

/**
 * Canonical comparison key: lowercase, drop a leading vendor prefix
 * (`anthropic/`, `openai/`, …), strip non-alphanumerics. Deliberately does
 * NOT strip version or variant information — that stripping is what made
 * the old matcher collapse distinct models onto each other.
 */
export function canonicalModelKey(id) {
  return String(id ?? "")
    .toLowerCase()
    .replace(/^[a-z0-9._-]+\//, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Canonical key with only a trailing release-date snapshot removed
 * (`-20250514`, `-20250514-v2`). Safe because every comparison is equality:
 * `claudeopus4` can never equal `claudeopus47`. Reasoning/effort suffixes
 * (`-thinking`, `-high`, `-max`, …) are intentionally preserved so a
 * variant cannot inherit its base model's record.
 */
export function dateStrippedModelKey(id) {
  return canonicalModelKey(String(id ?? "").replace(/-\d{8}(-v\d+)?$/i, ""));
}

/**
 * Reviewed local-id → benchmark-id aliases. Empty by default: an entry here
 * is an explicit human assertion that two differently-named records are the
 * same model, and is the ONLY sanctioned way to cross a version or variant
 * boundary. Compared as canonical keys.
 */
export const EXPLICIT_BENCHMARK_ALIASES = Object.freeze({
  // "local-model-id": "vendor/benchmark-model-id"
});

function rowKeys(row) {
  return [row?.model_permaslug, row?.display_name].filter((v) => typeof v === "string" && v.length);
}

/** Rows carrying both a quality index and a prompt price are preferred, since those are what value scoring consumes. */
function rowCompleteness(row) {
  const hasIndex = row?.intelligence_index != null || row?.coding_index != null;
  const hasPrice = row?.pricing?.prompt != null;
  return (hasIndex ? 2 : 0) + (hasPrice ? 1 : 0);
}

/**
 * Equality-only benchmark match. Tries, in order: exact canonical id, exact
 * date-stripped canonical id, then an explicit reviewed alias. Returns null
 * when nothing matches — a model with no confident match gets no benchmark
 * score rather than a neighbour's.
 *
 * @returns {{row: object, matchMethod: "exact"|"exact_normalized"|"explicit_alias", matchConfidence: "high"}|null}
 */
export function matchBenchmarkRow(localModelId, benchmarkRows) {
  const exactKey = canonicalModelKey(localModelId);
  if (!exactKey) {
    return null;
  }
  const looseKey = dateStrippedModelKey(localModelId);
  const aliasTarget = EXPLICIT_BENCHMARK_ALIASES[String(localModelId)];
  const aliasKey = aliasTarget ? canonicalModelKey(aliasTarget) : null;

  const buckets = { exact: [], exact_normalized: [], explicit_alias: [] };

  for (const row of benchmarkRows ?? []) {
    const keys = rowKeys(row);
    const canonical = keys.map(canonicalModelKey);
    const dateStripped = keys.map(dateStrippedModelKey);

    if (canonical.includes(exactKey)) {
      buckets.exact.push(row);
    } else if (dateStripped.includes(looseKey) || canonical.includes(looseKey)) {
      buckets.exact_normalized.push(row);
    } else if (aliasKey && (canonical.includes(aliasKey) || dateStripped.includes(aliasKey))) {
      buckets.explicit_alias.push(row);
    }
  }

  for (const method of ["exact", "exact_normalized", "explicit_alias"]) {
    const rows = buckets[method];
    if (!rows.length) {
      continue;
    }
    // Deterministic pick among the many duplicate rows the feed contains
    // for a single model: most complete first, then stable by permaslug.
    const chosen = [...rows].sort((a, b) => {
      const byCompleteness = rowCompleteness(b) - rowCompleteness(a);
      if (byCompleteness !== 0) {
        return byCompleteness;
      }
      return String(a.model_permaslug ?? "").localeCompare(String(b.model_permaslug ?? ""));
    })[0];
    return { row: chosen, matchMethod: method, matchConfidence: "high" };
  }

  return null;
}

async function fetchOpenRouterBenchmarks(apiKey) {
  const res = await fetch(OPENROUTER_BENCHMARKS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter benchmarks request failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

function snapshot(now = Date.now()) {
  const hasData = Boolean(cache.data) && cache.lastSuccessfulFetchAt > 0;
  const dataAgeMs = hasData ? now - cache.lastSuccessfulFetchAt : null;
  const stale = !hasData || dataAgeMs > MAX_USABLE_AGE_MS;
  return {
    enabled: true,
    // Rows stay visible for diagnostics even when stale; callers decide
    // whether to apply them by checking `stale` (openaiApi.js and
    // server.js pass [] into scoring when stale).
    rows: cache.data?.data ?? [],
    meta: cache.data?.meta ?? null,
    error: cache.error,
    lastAttemptAt: cache.lastAttemptAt ? new Date(cache.lastAttemptAt).toISOString() : null,
    lastSuccessfulFetchAt: cache.lastSuccessfulFetchAt ? new Date(cache.lastSuccessfulFetchAt).toISOString() : null,
    dataAgeMs,
    maxUsableAgeMs: MAX_USABLE_AGE_MS,
    stale,
    /** Back-compat alias for the pre-D-004C1 dashboard field. */
    cachedAt: cache.lastSuccessfulFetchAt ? new Date(cache.lastSuccessfulFetchAt).toISOString() : null
  };
}

/**
 * Returns cached benchmark data, re-attempting when the last *attempt* is
 * older than ATTEMPT_INTERVAL_MS. Never throws — errors surface in the
 * result so a bad key can't break the dashboard or a request.
 */
export async function getBenchmarkData(apiKey, { force = false } = {}) {
  if (!apiKey) {
    return {
      enabled: false,
      rows: [],
      meta: null,
      error: null,
      lastAttemptAt: null,
      lastSuccessfulFetchAt: null,
      dataAgeMs: null,
      maxUsableAgeMs: MAX_USABLE_AGE_MS,
      stale: true,
      cachedAt: null
    };
  }

  if (cache.apiKeyUsed !== apiKey) {
    cache = { lastAttemptAt: 0, lastSuccessfulFetchAt: 0, data: null, error: null, apiKeyUsed: apiKey };
  }

  const attemptDue = Date.now() - cache.lastAttemptAt > ATTEMPT_INTERVAL_MS;
  if (!force && !attemptDue && (cache.data || cache.error)) {
    return snapshot();
  }

  try {
    const body = await fetchOpenRouterBenchmarks(apiKey);
    const at = Date.now();
    cache = { lastAttemptAt: at, lastSuccessfulFetchAt: at, data: body, error: null, apiKeyUsed: apiKey };
  } catch (error) {
    // P0-7: only the attempt clock advances. lastSuccessfulFetchAt and the
    // previous payload are preserved exactly, so repeated failures can
    // never launder stale data into looking fresh.
    cache = {
      lastAttemptAt: Date.now(),
      lastSuccessfulFetchAt: cache.lastSuccessfulFetchAt,
      data: cache.data,
      error: error.message,
      apiKeyUsed: apiKey
    };
  }
  return snapshot();
}

/**
 * Attaches a matched external benchmark to each registry entry, with full
 * attribution (method, both ids, confidence, fetch time) so a score can
 * always be traced back to the row it came from. Entries with no confident
 * match are returned unchanged — never backfilled with a guess.
 */
export function annotateRegistryWithBenchmarks(registry, benchmarkRows, { fetchedAt = null } = {}) {
  return registry.map((entry) => {
    if (!entry.model) {
      return entry;
    }
    const match = matchBenchmarkRow(entry.model, benchmarkRows);
    if (!match) {
      return entry;
    }
    const { row, matchMethod, matchConfidence } = match;
    return {
      ...entry,
      externalBenchmark: {
        source: row.source,
        matchMethod,
        matchConfidence,
        matchedLocalModel: entry.model,
        matchedBenchmarkModel: row.model_permaslug || row.display_name,
        benchmarkFetchedAt: fetchedAt,
        /** Back-compat alias for the pre-D-004C1 dashboard field. */
        matchedAs: row.model_permaslug || row.display_name,
        intelligenceIndex: row.intelligence_index ?? null,
        codingIndex: row.coding_index ?? null,
        agenticIndex: row.agentic_index ?? null,
        elo: row.elo ?? null,
        winRate: row.win_rate ?? null,
        pricing: row.pricing ?? null
      }
    };
  });
}

/** Test-only: resets the module-level cache between test cases. */
export function resetBenchmarkCacheForTests() {
  cache = { lastAttemptAt: 0, lastSuccessfulFetchAt: 0, data: null, error: null, apiKeyUsed: null };
}

/** Test-only: seeds a specific cache state so staleness can be asserted without waiting 24h. */
export function seedBenchmarkCacheForTests(next) {
  cache = { ...cache, ...next };
}

/** Test-only: exposes the current cache timestamps for assertions. */
export function benchmarkCacheStateForTests() {
  return { ...cache };
}
