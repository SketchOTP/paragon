import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "./modelSnapshotStore.js";
import { assertNotProductionWrite } from "./dataPaths.js";

import {
  loadOrFetchPricingCatalog,
  lookupCatalogPricing,
  summarizePricingCoverage
} from "./modelPricingCatalog.js";
import {
  applyPricingValidation,
  hasTraceableValidPricing
} from "./researchAgent/pricingValidation.js";
import { loadResearchCatalog, lookupResearchPricing } from "./researchAgent/researchCatalog.js";



const OFFICIAL_OPENAI = {
  "gpt-4o": { input_per_1m: 2.5, cached_input_per_1m: 1.25, output_per_1m: 10 },
  "gpt-4o-mini": { input_per_1m: 0.15, cached_input_per_1m: 0.075, output_per_1m: 0.6 },
  "gpt-5.4": { input_per_1m: 2.5, output_per_1m: 15 },
  "gpt-5.4-mini": { input_per_1m: 0.75, cached_input_per_1m: 0.075, output_per_1m: 4.5 },
  "gpt-5-mini": { input_per_1m: 0.25, cached_input_per_1m: 0.025, output_per_1m: 2 }
};

const OFFICIAL_ANTHROPIC = {
  "claude-opus-4-6": { input_per_1m: 15, output_per_1m: 75 },
  "claude-sonnet-4-6": { input_per_1m: 3, output_per_1m: 15 },
  "claude-haiku-4-5": { input_per_1m: 0.8, output_per_1m: 4 }
};

/** Google Gemini via antigravity CLI — estimated from published API tiers. */
const OFFICIAL_GEMINI = {
  flash: { input_per_1m: 0.15, output_per_1m: 0.6 },
  pro: { input_per_1m: 1.25, output_per_1m: 5 }
};

/**
 * Subscription CLIs: marginal token cost may be $0 to the user, but we never
 * treat effective cost as free — ranker applies reliability/latency/quota penalties.
 * Token rates here are API-equivalent estimates for benchmark:cost ratios.
 */
const SUBSCRIPTION_FALLBACK = {
  input_per_1m: 1,
  cached_input_per_1m: 0.1,
  output_per_1m: 3,
  billing_model: "subscription",
  marginal_token_cost_known: false
};

const LOCAL_ZERO = {
  input_per_1m: 0,
  cached_input_per_1m: 0,
  output_per_1m: 0,
  batch_input_per_1m: 0,
  batch_output_per_1m: 0,
  priority_input_per_1m: null,
  priority_output_per_1m: null,
  tool_call_cost: null,
  pricing_source: "manual",
  pricing_confidence: 1,
  billing_model: "local",
  marginal_token_cost_known: true
};

const SUBSCRIPTION_PROVIDERS = new Set(["cursor", "codex", "antigravity", "claude"]);


export async function loadPricingOverrides() {
  try {
    const raw = await fs.readFile(PATHS.pricingOverrides, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function loadPricingCache() {
  try {
    const raw = await fs.readFile(PATHS.pricingCache, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function savePricingCache(cache) {
  assertNotProductionWrite(PATHS.pricingCache);
  await fs.mkdir(path.dirname(PATHS.pricingCache), { recursive: true });
  await fs.writeFile(PATHS.pricingCache, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export async function enrichModelPricing(models, config, options = {}) {
  const overrides = await loadPricingOverrides();
  const cache = await loadPricingCache();
  const now = new Date().toISOString();
  const catalog = await loadOrFetchPricingCatalog(config, {
    force: options.forcePricingCatalog === true
  });
  let researchCatalog = options.researchCatalog ?? null;
  if (researchCatalog === null) {
    try {
      researchCatalog = await loadResearchCatalog();
    } catch {
      researchCatalog = null;
    }
  }
  const nextCache = { ...cache };

  const enriched = models.map((row) => {
    const pricing = resolvePricing(row, overrides, cache, config, now, catalog, researchCatalog);
    nextCache[row.canonical_id] = pricing;
    return { ...row, pricing };
  });

  await savePricingCache(nextCache);
  return enriched;
}

export { summarizePricingCoverage };

export function resolvePricing(row, overrides, cache, config, now, catalog = null, researchCatalog = null) {
  if (overrides[row.canonical_id]) {
    return finalizePricing(
      normalizePricing(overrides[row.canonical_id], "manual", 1, now, row),
      row,
      {
        source_authority: "manual_override",
        route_context: routeContextFor(row),
        cost_sensitive_eligible: true,
        source_url: "manual://override"
      }
    );
  }

  if (row.local || row.provider.includes("local") || row.provider.includes("ollama")) {
    return finalizePricing(
      { ...LOCAL_ZERO, pricing_last_checked: now },
      row,
      { source_authority: "local", route_context: "local" }
    );
  }

  // Research catalog is preferred evidence for cost-sensitive routing.
  const researchHit = lookupResearchPricing(row, researchCatalog);
  if (researchHit) {
    return finalizePricing(
      normalizePricing(researchHit, researchHit.pricing_source ?? "research", researchHit.confidence ?? 0.95, now, row),
      row,
      researchHit
    );
  }

  // OpenRouter metadata only applies to openrouter routes.
  const openrouter = row.openrouter_metadata?.pricing;
  if (openrouter && row.provider === "openrouter") {
    return finalizePricing(
      normalizePricing(
        {
          input_per_1m: dollarsPerToken(openrouter.prompt),
          output_per_1m: dollarsPerToken(openrouter.completion),
          routed_input_per_1m: dollarsPerToken(openrouter.prompt),
          routed_output_per_1m: dollarsPerToken(openrouter.completion)
        },
        "openrouter",
        0.9,
        now,
        row
      ),
      row,
      {
        source_authority: "aggregator_pricing",
        route_context: "aggregator",
        source_url: "https://openrouter.ai/api/v1/models"
      }
    );
  }

  const catalogHit = catalog ? lookupCatalogPricing(row, catalog) : null;
  if (catalogHit && row.provider === "openrouter") {
    return finalizePricing(
      normalizePricing(catalogHit, catalogHit.pricing_source, catalogHit.pricing_confidence, now, row),
      row,
      {
        source_authority: "aggregator_pricing",
        route_context: "aggregator",
        source_url: "https://openrouter.ai/api/v1/models",
        pricing_match: catalogHit.pricing_match
      }
    );
  }

  // Aggregator catalog may hint underlying API prices for CLI adapters, but only
  // as estimates — not billing truth for cost-sensitive winners without research evidence.
  if (catalogHit && SUBSCRIPTION_PROVIDERS.has(row.provider)) {
    const estimate = finalizePricing(
      normalizePricing(
        { ...catalogHit, billing_model: "subscription", marginal_token_cost_known: false },
        "aggregator_hint",
        Math.min(catalogHit.pricing_confidence ?? 0.5, 0.5),
        now,
        row
      ),
      row,
      {
        source_authority: "aggregator_hint",
        route_context: "subscription",
        source_url: "https://openrouter.ai/api/v1/models",
        pricing_match: catalogHit.pricing_match
      }
    );
    // Hints alone cannot win cost-sensitive routing.
    return {
      ...estimate,
      pricing_status: estimate.pricing_status === "valid" ? "estimate" : estimate.pricing_status,
      cost_sensitive_eligible: false
    };
  }

  const modelKey = normalizeModelKey(row.model);
  if (row.provider === "openai") {
    const official = OFFICIAL_OPENAI[modelKey] ?? fuzzyOpenAi(modelKey);
    if (official) {
      return finalizePricing(
        normalizePricing(official, "official_openai", exactMatch(modelKey, official) ? 0.85 : 0.6, now, row),
        row,
        {
          source_authority: "static_official_table",
          route_context: "direct_provider",
          source_url: "https://openai.com/api/pricing/",
          cost_sensitive_eligible: exactMatch(modelKey, official)
        }
      );
    }
  }

  if (row.provider === "anthropic") {
    const official = OFFICIAL_ANTHROPIC[modelKey] ?? fuzzyAnthropic(modelKey);
    if (official) {
      return finalizePricing(
        normalizePricing(
          official,
          "official_anthropic",
          exactMatch(modelKey, official) ? 0.85 : 0.6,
          now,
          row
        ),
        row,
        {
          source_authority: "static_official_table",
          route_context: "direct_provider",
          source_url: "https://platform.claude.com/docs/en/about-claude/pricing",
          cost_sensitive_eligible: exactMatch(modelKey, official)
        }
      );
    }
  }

  // CLI adapters (claude/codex/cursor/antigravity): estimates only, not cost-sensitive winners
  if (SUBSCRIPTION_PROVIDERS.has(row.provider)) {
    const estimate =
      OFFICIAL_OPENAI[modelKey] ??
      fuzzyOpenAi(modelKey) ??
      fuzzyAnthropic(modelKey) ??
      fuzzyGemini(modelKey) ??
      SUBSCRIPTION_FALLBACK;
    const priced = finalizePricing(
      normalizePricing(
        { ...estimate, billing_model: "subscription", marginal_token_cost_known: false },
        row.provider === "cursor" ? "subscription_cli" : "subscription_estimate",
        0.4,
        now,
        row
      ),
      row,
      {
        source_authority: "subscription_estimate",
        route_context: "subscription",
        source_url: null
      }
    );
    return { ...priced, cost_sensitive_eligible: false, pricing_status: priced.pricing_status === "valid" ? "estimate" : priced.pricing_status };
  }

  if (cache[row.canonical_id]) {
    return finalizePricing({ ...cache[row.canonical_id], pricing_last_checked: now }, row, cache[row.canonical_id]);
  }

  return finalizePricing(normalizePricing({}, "unknown", 0, now, row), row, {
    source_authority: "unknown",
    route_context: routeContextFor(row)
  });
}

function routeContextFor(row) {
  if (row?.local || row?.provider?.includes("local") || row?.provider?.includes("ollama")) {
    return "local";
  }
  if (row?.provider === "openrouter") return "aggregator";
  if (SUBSCRIPTION_PROVIDERS.has(row?.provider)) return "subscription";
  return "direct_provider";
}

function finalizePricing(pricing, row, evidence = {}) {
  const validated = applyPricingValidation(pricing);
  const route_context = evidence.route_context ?? routeContextFor(row);
  const numbersOk = hasTraceableValidPricing(validated) || validated.pricing_status === "valid";

  let costSensitiveEligible = false;
  if (evidence.cost_sensitive_eligible === false) {
    costSensitiveEligible = false;
  } else if (evidence.cost_sensitive_eligible === true) {
    costSensitiveEligible = numbersOk && validated.pricing_status === "valid";
  } else {
    costSensitiveEligible =
      numbersOk &&
      validated.pricing_status === "valid" &&
      validated.pricing_source !== "unknown" &&
      route_context !== "subscription";
  }

  return {
    ...validated,
    route_context,
    source_url: evidence.source_url ?? validated.source_url ?? null,
    source_authority: evidence.source_authority ?? validated.source_authority ?? validated.pricing_source,
    source_hash: evidence.source_hash ?? validated.source_hash ?? null,
    fetched_at: evidence.fetched_at ?? validated.fetched_at ?? null,
    parsed_at: evidence.parsed_at ?? validated.parsed_at ?? validated.pricing_last_checked ?? null,
    evidence_label: evidence.evidence_label ?? evidence.pricing_match ?? null,
    extraction_method: evidence.extraction_method ?? null,
    cost_sensitive_eligible: costSensitiveEligible
  };
}

function billingMetaFor(row, raw, source) {
  if (raw.billing_model) {
    return {
      billing_model: raw.billing_model,
      marginal_token_cost_known: raw.marginal_token_cost_known ?? true,
      subscription_adjusted_cost: raw.subscription_adjusted_cost ?? null
    };
  }
  if (source === "manual" && row?.local) {
    return { billing_model: "local", marginal_token_cost_known: true, subscription_adjusted_cost: null };
  }
  if (SUBSCRIPTION_PROVIDERS.has(row?.provider)) {
    return {
      billing_model: "subscription",
      marginal_token_cost_known: source !== "subscription_cli" && source !== "unknown",
      subscription_adjusted_cost: null
    };
  }
  if (source === "unknown") {
    return { billing_model: "unknown", marginal_token_cost_known: false, subscription_adjusted_cost: null };
  }
  return { billing_model: "api_per_token", marginal_token_cost_known: true, subscription_adjusted_cost: null };
}

function normalizePricing(raw, source, confidence, now, row = null) {
  const billing = billingMetaFor(row, raw, source);
  return {
    input_per_1m: raw.input_per_1m ?? null,
    cached_input_per_1m: raw.cached_input_per_1m ?? null,
    output_per_1m: raw.output_per_1m ?? null,
    batch_input_per_1m: raw.batch_input_per_1m ?? null,
    batch_output_per_1m: raw.batch_output_per_1m ?? null,
    priority_input_per_1m: raw.priority_input_per_1m ?? null,
    priority_output_per_1m: raw.priority_output_per_1m ?? null,
    tool_call_cost: raw.tool_call_cost ?? null,
    routed_input_per_1m: raw.routed_input_per_1m ?? null,
    routed_output_per_1m: raw.routed_output_per_1m ?? null,
    pricing_source: source,
    pricing_last_checked: now,
    pricing_confidence: confidence,
    ...billing
  };
}

function dollarsPerToken(value) {
  if (value == null) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num * 1_000_000;
}

function normalizeModelKey(model) {
  return String(model ?? "default").toLowerCase().replace(/\s+/g, "-");
}

function fuzzyOpenAi(modelKey) {
  if (modelKey.includes("codex")) {
    if (modelKey.includes("mini")) return OFFICIAL_OPENAI["gpt-5-mini"];
    if (modelKey.includes("5.4")) return OFFICIAL_OPENAI["gpt-5.4"];
    return OFFICIAL_OPENAI["gpt-5.4"];
  }
  if (modelKey.includes("mini")) return OFFICIAL_OPENAI["gpt-4o-mini"];
  if (modelKey.includes("gpt-5")) return OFFICIAL_OPENAI["gpt-5-mini"];
  if (modelKey.includes("gpt-4")) return OFFICIAL_OPENAI["gpt-4o"];
  return null;
}

function fuzzyAnthropic(modelKey) {
  if (modelKey.includes("opus")) return OFFICIAL_ANTHROPIC["claude-opus-4-6"];
  if (modelKey.includes("haiku")) return OFFICIAL_ANTHROPIC["claude-haiku-4-5"];
  if (modelKey.includes("sonnet")) return OFFICIAL_ANTHROPIC["claude-sonnet-4-6"];
  return null;
}

function fuzzyGemini(modelKey) {
  const key = modelKey.toLowerCase();
  if (key.includes("flash")) return OFFICIAL_GEMINI.flash;
  if (key.includes("pro")) return OFFICIAL_GEMINI.pro;
  if (key.includes("gemini")) return OFFICIAL_GEMINI.flash;
  return null;
}

function exactMatch(modelKey, official) {
  return Boolean(OFFICIAL_OPENAI[modelKey] || OFFICIAL_ANTHROPIC[modelKey]);
}

export function hasKnownPricing(pricing) {
  if (!pricing) return false;
  if (pricing.cost_sensitive_eligible === false) return false;
  if (pricing.pricing_status === "invalid" || pricing.pricing_status === "estimate") return false;
  if (pricing.pricing_status === "unknown") return false;
  return hasTraceableValidPricing(pricing);
}

export function pricingBlocksCostSensitiveRoute(pricing, overrides = {}) {
  if (overrides.allow_unknown_pricing) {
    return false;
  }
  return !hasKnownPricing(pricing);
}
