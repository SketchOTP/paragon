/**
 * Benchmark extraction. SWE-bench is coding-only.
 * Uses known published scores as bootstrap when HTML parse is thin,
 * always tagged with source_url and match confidence.
 */

const SWE_BENCH_KNOWN = {
  "claude-sonnet-4-6": { score: 79.6, avg_cost: 0.1 },
  "claude-sonnet-4": { score: 72.7, avg_cost: 0.12 },
  "claude-opus-4": { score: 72.5, avg_cost: 0.5 },
  "claude-opus-4-6": { score: 72.5, avg_cost: 0.5 },
  "gpt-5": { score: 74.9, avg_cost: 0.2 },
  "gpt-4.1": { score: 54.6, avg_cost: 0.15 },
  "gemini-2.5-pro": { score: 63.8, avg_cost: 0.2 }
};

export function extractBenchmarksFromSource(fetchResult, models = []) {
  const now = new Date().toISOString();
  const sourceUrl = fetchResult?.url ?? "https://www.swebench.com/";
  const records = [];

  // Try to find percentages near model names in HTML
  const text = fetchResult?.text ?? "";
  for (const [key, meta] of Object.entries(SWE_BENCH_KNOWN)) {
    const re = new RegExp(`${escapeRegExp(key)}[^0-9]{0,40}([0-9]{1,2}(?:\\.[0-9]+)?)\\s*%`, "i");
    const match = text.match(re);
    const score = match ? Number(match[1]) : meta.score;
    records.push({
      model_key: key,
      benchmark: "swe_bench_verified",
      score,
      metric: "percent_resolved",
      avg_cost: meta.avg_cost,
      source_url: sourceUrl,
      fetched_at: now,
      match_type: match ? "exact" : "published_table",
      confidence: match ? 0.95 : 0.7,
      source_hash: fetchResult?.snapshot?.source_hash ?? null
    });
  }

  return attachToModels(records, models);
}

export function attachToModels(benchmarkRows, models) {
  const out = [];
  for (const model of models) {
    const key = String(model.model ?? "").toLowerCase();
    let best = null;
    for (const row of benchmarkRows) {
      const mk = row.model_key.toLowerCase();
      let matchType = null;
      let confidence = row.confidence;
      if (key === mk || key.includes(mk) || mk.includes(key)) {
        matchType = key === mk ? "exact" : "family";
        confidence = matchType === "exact" ? row.confidence : Math.min(row.confidence, 0.75);
      }
      if (!matchType) continue;
      if (!best || confidence > best.confidence) {
        best = {
          canonical_id: model.canonical_id,
          benchmark: row.benchmark,
          score: row.score,
          metric: row.metric,
          avg_cost: row.avg_cost,
          source_url: row.source_url,
          fetched_at: row.fetched_at,
          match_type: matchType,
          confidence,
          source_hash: row.source_hash
        };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
