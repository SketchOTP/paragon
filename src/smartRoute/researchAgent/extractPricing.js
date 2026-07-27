import { applyPricingValidation } from "./pricingValidation.js";

/**
 * Extract pricing records from a fetched source (JSON API or HTML).
 * Pass A: deterministic only. Pass B (LLM) is optional and must still validate.
 */
export function extractPricingFromSource(fetchResult, options = {}) {
  if (!fetchResult?.ok) {
    return { records: [], method: null, error: fetchResult?.error ?? "fetch_failed" };
  }

  const provider = fetchResult.provider;
  const authority = fetchResult.source?.authority ?? "unknown";
  const now = new Date().toISOString();

  if (fetchResult.json && provider === "openrouter") {
    return {
      records: extractOpenRouterPricing(fetchResult, now),
      method: "json_api",
      error: null
    };
  }

  if (fetchResult.json?.data && Array.isArray(fetchResult.json.data)) {
    // Generic OpenAI-style list rarely includes prices; skip.
  }

  const htmlRecords = extractHtmlPricingTables(fetchResult, now);
  if (htmlRecords.length) {
    return { records: htmlRecords, method: "table_parser", error: null };
  }

  if (options.llmExtractionEnabled && options.llmExtractFn) {
    const llmRecords = options.llmExtractFn(fetchResult);
    const validated = (llmRecords ?? [])
      .map((row) => validateExtractedRecord(row, fetchResult, now, "llm_assisted"))
      .filter(Boolean);
    return { records: validated, method: "llm_assisted", error: validated.length ? null : "llm_no_valid_rows" };
  }

  return { records: [], method: null, error: "no_pricing_extracted" };
}

function extractOpenRouterPricing(fetchResult, now) {
  const rows = fetchResult.json?.data ?? fetchResult.json?.models ?? [];
  const records = [];
  for (const row of rows) {
    const id = row.id ?? row.name;
    if (!id) continue;
    const prompt = Number(row.pricing?.prompt);
    const completion = Number(row.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;

    const record = validateExtractedRecord(
      {
        provider: "openrouter",
        model: id,
        canonical_id: `openrouter:${id}`,
        route_context: "aggregator",
        input_per_1m: prompt * 1_000_000,
        output_per_1m: completion * 1_000_000,
        cached_input_per_1m: row.pricing?.input_cache_read
          ? Number(row.pricing.input_cache_read) * 1_000_000
          : null,
        pricing_unit: "per_1m_tokens",
        currency: "USD",
        evidence_label: id
      },
      fetchResult,
      now,
      "json_api"
    );
    if (record) records.push(record);
  }
  return records;
}

function extractHtmlPricingTables(fetchResult, now) {
  const text = fetchResult.text ?? "";
  const provider = mapHtmlProvider(fetchResult.provider);
  const records = [];

  // Pattern: model-ish token near $X.xx / 1M style prices
  const patterns = [
    // "gpt-4o-mini" ... "$0.15" ... "$0.60"
    /([a-z0-9][a-z0-9._-]{2,40})\s[^$]{0,80}\$([0-9]+(?:\.[0-9]+)?)\s*(?:\/|\s+per\s+)?(?:1m|1M|million)?[^$]{0,40}\$([0-9]+(?:\.[0-9]+)?)/gi
  ];

  const knownModels = knownModelHints(provider);
  for (const model of knownModels) {
    const re = new RegExp(
      `${escapeRegExp(model)}[^$]{0,120}\\$([0-9]+(?:\\.[0-9]+)?)[^$]{0,80}\\$([0-9]+(?:\\.[0-9]+)?)`,
      "i"
    );
    const match = text.match(re);
    if (!match) continue;
    const input = Number(match[1]);
    const output = Number(match[2]);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    // Heuristic: first price is usually input, second output; if input > output * 5, swap
    let inputPer1m = input;
    let outputPer1m = output;
    if (inputPer1m > outputPer1m * 5) {
      // likely already per-1M and order ok, or mis-ordered — keep as-is if both small
    }
    // If values look like per-token dollars (very small), scale
    if (inputPer1m < 0.0001) {
      inputPer1m *= 1_000_000;
      outputPer1m *= 1_000_000;
    }

    const record = validateExtractedRecord(
      {
        provider,
        model,
        canonical_id: `${provider}:${model}`,
        route_context: "direct_provider",
        input_per_1m: inputPer1m,
        output_per_1m: outputPer1m,
        pricing_unit: "per_1m_tokens",
        currency: "USD",
        evidence_label: match[0].slice(0, 120)
      },
      fetchResult,
      now,
      "table_parser"
    );
    if (record) records.push(record);
  }

  // Also try patterns for unlabeled rows
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) && records.length < 200) {
      const model = match[1];
      if (!looksLikeModelId(model)) continue;
      let inputPer1m = Number(match[2]);
      let outputPer1m = Number(match[3]);
      if (inputPer1m < 0.0001) {
        inputPer1m *= 1_000_000;
        outputPer1m *= 1_000_000;
      }
      const record = validateExtractedRecord(
        {
          provider,
          model,
          canonical_id: `${provider}:${model}`,
          route_context: provider === "openrouter" ? "aggregator" : "direct_provider",
          input_per_1m: inputPer1m,
          output_per_1m: outputPer1m,
          pricing_unit: "per_1m_tokens",
          currency: "USD",
          evidence_label: match[0].slice(0, 120)
        },
        fetchResult,
        now,
        "table_parser"
      );
      if (record) records.push(record);
    }
  }

  return dedupeRecords(records);
}

function validateExtractedRecord(raw, fetchResult, now, method) {
  const pricing = applyPricingValidation({
    input_per_1m: raw.input_per_1m,
    output_per_1m: raw.output_per_1m,
    cached_input_per_1m: raw.cached_input_per_1m ?? null,
    batch_input_per_1m: raw.batch_input_per_1m ?? null,
    batch_output_per_1m: raw.batch_output_per_1m ?? null,
    tool_call_cost: raw.tool_call_cost ?? null,
    web_search_cost: raw.web_search_cost ?? null,
    pricing_source: fetchResult.source?.authority ?? method,
    billing_model: raw.route_context === "aggregator" ? "api_per_token" : "api_per_token"
  });

  if (pricing.pricing_status !== "valid") {
    return {
      ...raw,
      ...pricing,
      source_url: fetchResult.url,
      source_authority: fetchResult.source?.authority ?? "unknown",
      source_hash: fetchResult.snapshot?.source_hash ?? null,
      fetched_at: fetchResult.snapshot?.fetched_at ?? now,
      parsed_at: now,
      confidence: 0,
      extraction_method: method,
      pricing_unit: raw.pricing_unit ?? "per_1m_tokens",
      currency: raw.currency ?? "USD"
    };
  }

  return {
    provider: raw.provider,
    model: raw.model,
    canonical_id: raw.canonical_id,
    route_context: raw.route_context,
    input_per_1m: pricing.input_per_1m,
    cached_input_per_1m: pricing.cached_input_per_1m,
    output_per_1m: pricing.output_per_1m,
    batch_input_per_1m: pricing.batch_input_per_1m,
    batch_output_per_1m: pricing.batch_output_per_1m,
    tool_call_cost: pricing.tool_call_cost,
    web_search_cost: pricing.web_search_cost,
    pricing_unit: raw.pricing_unit ?? "per_1m_tokens",
    currency: raw.currency ?? "USD",
    source_url: fetchResult.url,
    source_authority: fetchResult.source?.authority ?? "unknown",
    source_hash: fetchResult.snapshot?.source_hash ?? null,
    fetched_at: fetchResult.snapshot?.fetched_at ?? now,
    parsed_at: now,
    confidence: method === "json_api" ? 0.95 : method === "table_parser" ? 0.8 : 0.6,
    extraction_method: method,
    evidence_label: raw.evidence_label ?? null,
    pricing_status: "valid",
    pricing_invalid_reason: null,
    pricing_source: fetchResult.source?.authority ?? method
  };
}

function mapHtmlProvider(provider) {
  if (provider === "google_gemini") return "google";
  return provider;
}

function knownModelHints(provider) {
  if (provider === "openai") {
    return ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-5.4", "gpt-5.4-mini", "o3", "o4-mini"];
  }
  if (provider === "anthropic") {
    return [
      "claude-opus-4",
      "claude-opus-4-6",
      "claude-sonnet-4",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-3-5-haiku",
      "claude-3-5-sonnet"
    ];
  }
  if (provider === "google" || provider === "google_gemini") {
    return ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"];
  }
  return [];
}

function looksLikeModelId(value) {
  const v = String(value).toLowerCase();
  if (v.length < 5 || v.length > 48) return false;
  if (["input", "output", "price", "model", "tokens", "prompt", "completion"].includes(v)) return false;
  return /^(gpt|o\d|claude|gemini|gemini-|chatgpt)/.test(v);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeRecords(records) {
  const byId = new Map();
  for (const row of records) {
    const prev = byId.get(row.canonical_id);
    if (!prev || (row.confidence ?? 0) > (prev.confidence ?? 0)) {
      byId.set(row.canonical_id, row);
    }
  }
  return [...byId.values()];
}
