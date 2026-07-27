import {
  catalogHash,
  readJson,
  RESEARCH_PATHS,
  writeJson
} from "./sourceSnapshotStore.js";
import { pickPricingForRoute } from "./crossValidatePricing.js";

export async function loadResearchCatalog() {
  return readJson(RESEARCH_PATHS.current, null);
}

export async function loadPricingEvidence() {
  return readJson(RESEARCH_PATHS.pricingEvidence, {});
}

export async function loadBenchmarkEvidence() {
  return readJson(RESEARCH_PATHS.benchmarkEvidence, {});
}

export async function saveResearchCatalog(catalog) {
  const hash = catalogHash(catalog);
  const payload = { ...catalog, research_hash: hash };
  await writeJson(RESEARCH_PATHS.current, payload);
  const day = (catalog.generated_at ?? new Date().toISOString()).slice(0, 10);
  await writeJson(`${RESEARCH_PATHS.historyDir}/${day}.json`, payload);
  return payload;
}

export async function savePricingEvidence(records) {
  const byId = {};
  for (const row of records) {
    byId[row.canonical_id] = row;
  }
  await writeJson(RESEARCH_PATHS.pricingEvidence, byId);
  return byId;
}

export async function saveBenchmarkEvidence(records) {
  const byId = {};
  for (const row of records) {
    byId[row.canonical_id] = row;
  }
  await writeJson(RESEARCH_PATHS.benchmarkEvidence, byId);
  return byId;
}

/**
 * Lookup research pricing for a discovered model row.
 * OpenRouter prices only apply to openrouter provider.
 * Direct providers use official/direct evidence only.
 */
export function lookupResearchPricing(row, catalog) {
  if (!catalog?.pricing?.length) return null;

  const byId = catalog.pricing_by_id ?? indexPricing(catalog.pricing);
  const direct = byId[row.canonical_id];
  const routeContext =
    row.provider === "openrouter"
      ? "aggregator"
      : row.local || row.provider?.includes("local")
        ? "local"
        : ["cursor", "codex", "claude", "antigravity"].includes(row.provider)
          ? "subscription"
          : "direct_provider";

  if (direct) {
    const picked = pickPricingForRoute(direct, routeContext);
    if (picked && picked.pricing_status === "valid" && picked.cost_sensitive_eligible !== false) {
      return mapToResolveShape(picked);
    }
    // For subscription adapters, allow estimate records but mark ineligible upstream
    if (picked && routeContext === "subscription") {
      return { ...mapToResolveShape(picked), cost_sensitive_eligible: false };
    }
  }

  // Map CLI models to underlying direct provider evidence when model id matches.
  // Known underlying API prices may participate in cost-sensitive ranking, but
  // remain tagged as subscription route_context for effective-cost penalties.
  if (routeContext === "subscription") {
    for (const prefix of ["openai", "anthropic", "google"]) {
      const candidate = byId[`${prefix}:${row.model}`];
      if (candidate?.pricing_status === "valid" && candidate.route_context === "direct_provider") {
        return {
          ...mapToResolveShape(candidate),
          billing_model: "subscription",
          route_context: "subscription",
          cost_sensitive_eligible: true,
          pricing_source: "underlying_direct_price",
          source_authority: candidate.source_authority,
          evidence_label: `underlying:${candidate.canonical_id}`
        };
      }
    }

    // Fuzzy family match on model slug against direct evidence
    const slug = normalizeSlug(row.model);
    let best = null;
    let bestScore = 0;
    for (const candidate of catalog.pricing) {
      if (candidate.route_context !== "direct_provider" || candidate.pricing_status !== "valid") {
        continue;
      }
      const score = familyMatchScore(slug, normalizeSlug(candidate.model));
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best && bestScore >= 2) {
      return {
        ...mapToResolveShape(best),
        billing_model: "subscription",
        route_context: "subscription",
        cost_sensitive_eligible: true,
        pricing_source: "underlying_direct_price",
        confidence: Math.min(best.confidence ?? 0.8, 0.75),
        evidence_label: `underlying_fuzzy:${best.canonical_id}`
      };
    }
  }

  return null;
}

function normalizeSlug(model) {
  return String(model ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[()]/g, "");
}

function familyMatchScore(slug, candSlug) {
  if (!slug || !candSlug) return 0;
  if (slug === candSlug || slug.includes(candSlug) || candSlug.includes(slug)) return 3;

  const tokens = (value) => {
    const out = new Set();
    if (value.includes("gemini")) out.add("gemini");
    if (value.includes("flash")) out.add("flash");
    if (value.includes("pro") && !value.includes("prompt")) out.add("pro");
    if (value.includes("claude")) out.add("claude");
    if (value.includes("haiku")) out.add("haiku");
    if (value.includes("sonnet")) out.add("sonnet");
    if (value.includes("opus")) out.add("opus");
    if (value.includes("gpt")) out.add("gpt");
    if (value.includes("mini")) out.add("mini");
    return out;
  };

  const a = tokens(slug);
  const b = tokens(candSlug);
  let score = 0;
  for (const t of a) {
    if (b.has(t)) score += 1;
  }
  // Require a family anchor (gemini/claude/gpt) plus a tier token
  const anchors = ["gemini", "claude", "gpt"];
  const hasAnchor = anchors.some((t) => a.has(t) && b.has(t));
  return hasAnchor ? score : 0;
}

function indexPricing(pricing) {
  const byId = {};
  for (const row of pricing) {
    byId[row.canonical_id] = row;
  }
  return byId;
}

function mapToResolveShape(row) {
  return {
    input_per_1m: row.input_per_1m,
    output_per_1m: row.output_per_1m,
    cached_input_per_1m: row.cached_input_per_1m,
    batch_input_per_1m: row.batch_input_per_1m,
    batch_output_per_1m: row.batch_output_per_1m,
    tool_call_cost: row.tool_call_cost,
    pricing_source: row.source_authority ?? row.pricing_source,
    confidence: row.confidence ?? 0.9,
    source_url: row.source_url,
    source_authority: row.source_authority,
    source_hash: row.source_hash,
    fetched_at: row.fetched_at,
    parsed_at: row.parsed_at,
    evidence_label: row.evidence_label,
    extraction_method: row.extraction_method,
    route_context: row.route_context,
    billing_model: row.route_context === "subscription" ? "subscription" : "api_per_token",
    cost_sensitive_eligible: row.cost_sensitive_eligible,
    pricing_status: row.pricing_status
  };
}

export function summarizeResearchCoverage(catalog) {
  const pricing = catalog?.pricing ?? [];
  let valid = 0;
  let invalid = 0;
  let estimate = 0;
  let withEvidence = 0;
  for (const row of pricing) {
    if (row.source_url && row.source_hash) withEvidence += 1;
    if (row.pricing_status === "valid" && row.cost_sensitive_eligible !== false) valid += 1;
    else if (row.pricing_status === "invalid") invalid += 1;
    else estimate += 1;
  }
  return {
    total: pricing.length,
    valid_cost_sensitive: valid,
    invalid,
    estimate_or_ineligible: estimate,
    with_source_evidence: withEvidence,
    models: catalog?.models?.length ?? 0,
    benchmarks: catalog?.benchmarks?.length ?? 0,
    research_hash: catalog?.research_hash ?? null,
    generated_at: catalog?.generated_at ?? null
  };
}
