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
 */

const OPENROUTER_BENCHMARKS_URL = "https://openrouter.ai/api/v1/benchmarks";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // benchmarks are not real-time data; refresh every 6h

let cache = { at: 0, data: null, error: null, apiKeyUsed: null };

/** Strips reasoning-effort/variant decorations so a local model id can be compared against OpenRouter's canonical naming. Best-effort only — never assumed exact. */
export function normalizeModelKey(id) {
  return String(id ?? "")
    .toLowerCase()
    .replace(/-\d{8}(-v\d+)?$/, "") // date-stamped snapshot suffixes
    .replace(/-(thinking|xhigh|high|medium|low|none|max|fast|mini|nano)(?=-|$)/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Best-effort match of a local registry entry to an OpenRouter benchmark
 * row. Substring containment on normalized keys, not fuzzy/approximate —
 * a false "no match" is safe (falls back to internal-only scoring); a
 * false positive would misattribute a benchmark to the wrong model, which
 * is the failure mode to avoid.
 */
export function matchBenchmarkRow(localModelId, benchmarkRows) {
  const localKey = normalizeModelKey(localModelId);
  if (!localKey) {
    return null;
  }
  let best = null;
  for (const row of benchmarkRows) {
    const candidates = [row.model_permaslug, row.display_name].filter(Boolean).map(normalizeModelKey);
    for (const candidateKey of candidates) {
      if (!candidateKey) continue;
      if (candidateKey === localKey || candidateKey.includes(localKey) || localKey.includes(candidateKey)) {
        // Prefer the longest/most-specific match found so far.
        if (!best || candidateKey.length > normalizeModelKey(best.model_permaslug || best.display_name).length) {
          best = row;
        }
      }
    }
  }
  return best;
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

/** Returns cached benchmark data, refetching if stale/missing/key changed. Never throws — errors are returned in the result so a bad key doesn't break the dashboard. */
export async function getBenchmarkData(apiKey, { force = false } = {}) {
  if (!apiKey) {
    return { enabled: false, rows: [], meta: null, error: null, cachedAt: null };
  }
  const stale = Date.now() - cache.at > CACHE_TTL_MS;
  if (!force && !stale && cache.apiKeyUsed === apiKey && (cache.data || cache.error)) {
    return {
      enabled: true,
      rows: cache.data?.data ?? [],
      meta: cache.data?.meta ?? null,
      error: cache.error,
      cachedAt: new Date(cache.at).toISOString()
    };
  }
  try {
    const body = await fetchOpenRouterBenchmarks(apiKey);
    cache = { at: Date.now(), data: body, error: null, apiKeyUsed: apiKey };
  } catch (error) {
    cache = { at: Date.now(), data: cache.apiKeyUsed === apiKey ? cache.data : null, error: error.message, apiKeyUsed: apiKey };
  }
  return {
    enabled: true,
    rows: cache.data?.data ?? [],
    meta: cache.data?.meta ?? null,
    error: cache.error,
    cachedAt: new Date(cache.at).toISOString()
  };
}

/** Attaches a matched external benchmark (if any) to each registry entry. Entries with no match are returned unchanged — never backfilled with a guess. */
export function annotateRegistryWithBenchmarks(registry, benchmarkRows) {
  return registry.map((entry) => {
    const match = matchBenchmarkRow(entry.model, benchmarkRows);
    if (!match) {
      return entry;
    }
    return {
      ...entry,
      externalBenchmark: {
        source: match.source,
        matchedAs: match.model_permaslug || match.display_name,
        intelligenceIndex: match.intelligence_index ?? null,
        codingIndex: match.coding_index ?? null,
        agenticIndex: match.agentic_index ?? null,
        elo: match.elo ?? null,
        winRate: match.win_rate ?? null,
        pricing: match.pricing ?? null
      }
    };
  });
}

/** Test-only: resets the module-level cache between test cases. */
export function resetBenchmarkCacheForTests() {
  cache = { at: 0, data: null, error: null, apiKeyUsed: null };
}
