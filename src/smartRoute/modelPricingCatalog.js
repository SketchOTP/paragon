import fs from "node:fs/promises";
import path from "node:path";
import { parseOpenRouterModelListResponse } from "./modelDiscovery.js";
import { PATHS } from "./modelSnapshotStore.js";
import { assertNotProductionWrite } from "./dataPaths.js";


const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_CATALOG_MAX_AGE_HOURS = 24;

/** @typedef {{ byId: Map<string, object>, bySlug: Map<string, { pricing: object, openrouter_id: string }> }} PricingCatalogIndex */

export async function loadOrFetchPricingCatalog(config, { force = false } = {}) {
  const refresh = config?.routing?.smartRoute?.modelRefresh ?? {};
  const maxAgeHours = refresh.pricingCatalogMaxAgeHours ?? DEFAULT_CATALOG_MAX_AGE_HOURS;
  const cached = await readCatalogCache();
  const ageHours = cached?.fetched_at
    ? (Date.now() - Date.parse(cached.fetched_at)) / 3_600_000
    : Infinity;

  if (!force && cached?.index && ageHours <= maxAgeHours) {
    return rehydrateIndex(cached.index);
  }

  try {
    const index = await fetchOpenRouterCatalog(config);
    await writeCatalogCache({
      fetched_at: new Date().toISOString(),
      model_count: index.byId.size,
      index: serializeIndex(index)
    });
    return index;
  } catch (error) {
    if (cached?.index) {
      return {
        ...rehydrateIndex(cached.index),
        stale: true,
        fetch_error: error.message
      };
    }
    throw error;
  }
}

async function fetchOpenRouterCatalog(config) {
  const providerConfig = config?.providers?.openrouter ?? {};
  const baseUrl = (providerConfig.baseUrl ?? "https://openrouter.ai/api").replace(/\/$/, "");
  const url = `${baseUrl}/v1/models`;
  const headers = { Accept: "application/json" };
  const apiKey = providerConfig.apiKey ?? providerConfig.api_key ?? process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
  if (!response.ok) {
    throw new Error(`OpenRouter pricing catalog HTTP ${response.status}`);
  }
  const json = await response.json();
  const rows = parseOpenRouterModelListResponse(json);
  return buildCatalogIndex(rows);
}

export function buildCatalogIndex(rows) {
  /** @type {PricingCatalogIndex} */
  const index = { byId: new Map(), bySlug: new Map() };

  for (const row of rows) {
    const pricing = openRouterRowToPricing(row.pricing);
    if (pricing.input_per_1m == null && pricing.output_per_1m == null) {
      continue;
    }
    index.byId.set(row.id, { ...pricing, openrouter_id: row.id });
    const slug = row.id.split("/").pop()?.toLowerCase() ?? "";
    if (slug && !index.bySlug.has(slug)) {
      index.bySlug.set(slug, { pricing, openrouter_id: row.id });
    }
  }

  return index;
}

function openRouterRowToPricing(raw) {
  if (!raw) {
    return { input_per_1m: null, output_per_1m: null };
  }
  return {
    input_per_1m: dollarsPerToken(raw.prompt),
    output_per_1m: dollarsPerToken(raw.completion),
    cached_input_per_1m: dollarsPerToken(raw.prompt_cache ?? raw.input_cache_read),
    routed_input_per_1m: dollarsPerToken(raw.prompt),
    routed_output_per_1m: dollarsPerToken(raw.completion)
  };
}

function dollarsPerToken(value) {
  if (value == null) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num * 1_000_000;
}

export function lookupCatalogPricing(row, catalog) {
  if (!catalog?.byId?.size) {
    return null;
  }

  for (const candidate of generateOpenRouterCandidates(row)) {
    const hit = catalog.byId.get(candidate);
    if (hit?.input_per_1m != null || hit?.output_per_1m != null) {
      return {
        ...hit,
        pricing_source: "openrouter_catalog",
        pricing_confidence: candidate === hit.openrouter_id ? 0.95 : 0.9,
        pricing_match: candidate
      };
    }
  }

  const slug = normalizeModelKey(row.model);
  const direct = catalog.bySlug.get(slug);
  if (direct) {
    return {
      ...direct.pricing,
      openrouter_id: direct.openrouter_id,
      pricing_source: "openrouter_catalog",
      pricing_confidence: 0.85,
      pricing_match: direct.openrouter_id
    };
  }

  const fuzzy = fuzzySlugMatch(slug, catalog.bySlug);
  if (fuzzy) {
    return {
      ...fuzzy.pricing,
      openrouter_id: fuzzy.openrouter_id,
      pricing_source: "openrouter_catalog",
      pricing_confidence: 0.7,
      pricing_match: fuzzy.openrouter_id
    };
  }

  return null;
}

export function generateOpenRouterCandidates(row) {
  const model = String(row.model ?? "default");
  const slug = normalizeModelKey(model);
  const out = new Set();

  const prefixMap = {
    claude: ["anthropic"],
    anthropic: ["anthropic"],
    codex: ["openai"],
    openai: ["openai"],
    cursor: ["openai", "anthropic", "google"],
    antigravity: ["google", "anthropic"]
  };

  for (const prefix of prefixMap[row.provider] ?? []) {
    out.add(`${prefix}/${model}`);
    out.add(`${prefix}/${slug}`);
  }

  for (const variant of expandModelVariants(slug)) {
    if (variant.includes("claude") || row.provider === "claude" || row.provider === "anthropic") {
      out.add(`anthropic/${variant}`);
    }
    if (variant.includes("gpt") || variant.includes("codex") || row.provider === "codex") {
      out.add(`openai/${variant}`);
    }
    if (variant.includes("gemini") || row.provider === "antigravity") {
      out.add(`google/${variant}`);
    }
  }

  return [...out];
}

function expandModelVariants(slug) {
  const variants = new Set([slug]);
  const stripped = slug
    .replace(/\((high|low|medium|xhigh|fast|thinking)\)/gi, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  variants.add(stripped);

  const parts = stripped.split("-");
  while (parts.length > 2) {
    parts.pop();
    variants.add(parts.join("-"));
  }

  if (stripped.includes("codex")) {
    variants.add(stripped.replace(/-max.*$/, "-max"));
    variants.add(stripped.replace(/-codex.*$/, "-codex"));
  }

  return [...variants].filter(Boolean);
}

function fuzzySlugMatch(slug, bySlug) {
  const geminiHit = fuzzyGeminiSlugMatch(slug, bySlug);
  if (geminiHit) {
    return geminiHit;
  }

  const core = slug.replace(/\([^)]*\)/g, "").replace(/-(high|low|medium|xhigh|fast|thinking)$/i, "");
  let best = null;
  let bestLen = 0;

  for (const [catalogSlug, entry] of bySlug) {
    if (core.includes(catalogSlug) || catalogSlug.includes(core)) {
      const overlap = Math.min(core.length, catalogSlug.length);
      if (overlap > bestLen) {
        bestLen = overlap;
        best = entry;
      }
    }
  }

  return best;
}

function fuzzyGeminiSlugMatch(slug, bySlug) {
  const want = geminiTokens(slug);
  if (!want.includes("gemini")) {
    return null;
  }

  let best = null;
  let bestScore = 0;
  for (const [catalogSlug, entry] of bySlug) {
    if (!catalogSlug.includes("gemini")) {
      continue;
    }
    const have = geminiTokens(catalogSlug);
    const score = want.filter((token) => have.includes(token)).length;
    if (score >= 2 && score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

function geminiTokens(slug) {
  const tokens = [];
  if (slug.includes("gemini")) tokens.push("gemini");
  if (slug.includes("flash")) tokens.push("flash");
  if (slug.includes("pro")) tokens.push("pro");
  return tokens;
}

function normalizeModelKey(model) {
  return String(model ?? "default")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[()]/g, "");
}

async function readCatalogCache() {
  try {
    const raw = await fs.readFile(PATHS.pricingCatalog, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeCatalogCache(payload) {
  assertNotProductionWrite(PATHS.pricingCatalog);
  await fs.mkdir(path.dirname(PATHS.pricingCatalog), { recursive: true });
  await fs.writeFile(PATHS.pricingCatalog, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function serializeIndex(index) {
  return {
    byId: [...index.byId.entries()],
    bySlug: [...index.bySlug.entries()]
  };
}

function rehydrateIndex(serialized) {
  return {
    byId: new Map(serialized.byId ?? []),
    bySlug: new Map(serialized.bySlug ?? [])
  };
}

export function summarizePricingCoverage(models) {
  let known = 0;
  let unknown = 0;
  let invalid = 0;
  let costSensitiveEligible = 0;
  const bySource = {};

  for (const row of models) {
    const pricing = row.pricing ?? {};
    const source = pricing.pricing_source ?? "missing";
    bySource[source] = (bySource[source] ?? 0) + 1;
    if (pricing.pricing_status === "invalid") {
      invalid += 1;
      unknown += 1;
      continue;
    }
    if (
      source === "unknown" ||
      pricing.input_per_1m == null ||
      pricing.pricing_status === "unknown" ||
      pricing.cost_sensitive_eligible === false
    ) {
      unknown += 1;
    } else {
      known += 1;
      costSensitiveEligible += 1;
    }
  }

  return {
    total: models.length,
    known,
    unknown,
    invalid,
    cost_sensitive_eligible: costSensitiveEligible,
    known_rate: models.length ? round(known / models.length) : 0,
    by_source: bySource
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
