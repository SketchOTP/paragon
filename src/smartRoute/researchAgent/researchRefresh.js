import {
  loadProviderSources,
  listPricingSources,
  listAvailabilitySources,
  listBenchmarkSources,
  mergeResearchAgentConfig
} from "./providerSources.js";
import { fetchSource } from "./fetchSource.js";
import { extractPricingFromSource } from "./extractPricing.js";
import { extractModelsFromSource, configuredModels } from "./extractModels.js";
import { extractBenchmarksFromSource } from "./extractBenchmarks.js";
import { crossValidatePricing } from "./crossValidatePricing.js";
import {
  loadPricingEvidence,
  loadResearchCatalog,
  saveBenchmarkEvidence,
  savePricingEvidence,
  saveResearchCatalog,
  summarizeResearchCoverage
} from "./researchCatalog.js";
import {
  appendResearchLog,
  catalogHash,
  RESEARCH_PATHS
} from "./sourceSnapshotStore.js";

let researchInFlight = null;
let lastResearchResult = null;

export async function runResearchRefresh(config, options = {}) {
  if (researchInFlight) return researchInFlight;

  const researchConfig = mergeResearchAgentConfig(config?.routing?.smartRoute ?? {});
  researchInFlight = (async () => {
    const started = Date.now();
    const previous = await loadResearchCatalog();
    const previousEvidence = await loadPricingEvidence();

    const sourcesFetched = [];
    const sourceFailures = [];
    const pricingRecords = [];
    const modelRecords = [];
    let benchmarkRecords = [];

    try {
      const registry = await loadProviderSources();
      const pricingSources = listPricingSources(registry);
      const availabilitySources = listAvailabilitySources(registry);
      const benchmarkSources = listBenchmarkSources(registry);

      for (const source of [...pricingSources, ...availabilitySources, ...benchmarkSources]) {
        if (source.type?.includes("configured") && !source.url) {
          modelRecords.push(...configuredModels(source.provider, config));
          sourcesFetched.push({
            provider: source.provider,
            source_id: source.id,
            kind: source.kind,
            ok: true,
            method: "configured"
          });
          continue;
        }

        const fetched = await fetchSource(source, { provider: source.provider, config });
        if (!fetched.ok) {
          sourceFailures.push({
            provider: source.provider,
            source_id: source.id,
            url: source.url,
            error: fetched.error
          });
          continue;
        }

        sourcesFetched.push({
          provider: source.provider,
          source_id: source.id,
          kind: source.kind,
          ok: true,
          source_hash: fetched.snapshot?.source_hash,
          url: source.url,
          duration_ms: fetched.fetch_duration_ms
        });

        if (source.kind === "pricing") {
          const extracted = extractPricingFromSource(fetched, {
            llmExtractionEnabled: researchConfig.llmExtractionEnabled && options.llmExtractionEnabled !== false
          });
          pricingRecords.push(...extracted.records);
        }

        if (source.kind === "availability") {
          const extracted = extractModelsFromSource(fetched, config);
          modelRecords.push(...extracted.models);
        }

        if (source.kind === "benchmarks") {
          benchmarkRecords = extractBenchmarksFromSource(fetched, modelRecords);
        }
      }

      // Always include configured CLI models for mapping
      for (const provider of ["claude", "codex", "cursor", "antigravity", "lmstudio"]) {
        modelRecords.push(...configuredModels(provider, config));
      }

      if (sourceFailures.length && !pricingRecords.length && previous?.pricing?.length) {
        const preserved = {
          ...previous,
          stale: true,
          refresh_status: "partial",
          last_error: "source_fetch_failed",
          last_refresh_attempt: new Date().toISOString(),
          source_failures: sourceFailures
        };
        await saveResearchCatalog(preserved);
        lastResearchResult = {
          ok: false,
          partial: true,
          preserved: true,
          catalog: preserved,
          source_failures: sourceFailures
        };
        await appendResearchLog({
          status: "partial",
          error: "source_fetch_failed",
          source_failures: sourceFailures,
          duration_ms: Date.now() - started
        });
        return lastResearchResult;
      }

      // Bootstrap official tables when live HTML extraction yields nothing for a provider.
      pricingRecords.push(...bootstrapOfficialPricing(pricingRecords));

      const validated = crossValidatePricing(pricingRecords, previousEvidence, researchConfig);
      const models = dedupeModels(modelRecords);
      if (!benchmarkRecords.length) {
        benchmarkRecords = extractBenchmarksFromSource({ ok: true, text: "", url: "https://www.swebench.com/" }, models);
      }

      const catalog = {
        version: 1,
        generated_at: new Date().toISOString(),
        refresh_status: "ok",
        stale: false,
        refresh_duration_ms: Date.now() - started,
        models,
        pricing: validated.pricing,
        pricing_by_id: Object.fromEntries(validated.pricing.map((r) => [r.canonical_id, r])),
        benchmarks: benchmarkRecords,
        price_changes: validated.priceChanges,
        requires_review: validated.requiresReview,
        invalid_pricing: validated.invalid,
        sources_fetched: sourcesFetched,
        source_failures: sourceFailures
      };

      catalog.research_hash = catalogHash(catalog);
      catalog.coverage = summarizeResearchCoverage(catalog);

      const saved = await saveResearchCatalog(catalog);
      await savePricingEvidence(validated.pricing);
      await saveBenchmarkEvidence(benchmarkRecords);

      lastResearchResult = { ok: true, catalog: saved, coverage: catalog.coverage };
      await appendResearchLog({
        status: "ok",
        duration_ms: catalog.refresh_duration_ms,
        coverage: catalog.coverage,
        price_changes: validated.priceChanges.length,
        source_failures: sourceFailures.length,
        research_hash: catalog.research_hash
      });
      return lastResearchResult;
    } catch (error) {
      if (previous?.pricing?.length) {
        const preserved = {
          ...previous,
          stale: true,
          refresh_status: "failed",
          last_error: error.message,
          last_refresh_attempt: new Date().toISOString()
        };
        await saveResearchCatalog(preserved);
        lastResearchResult = { ok: false, preserved: true, error: error.message, catalog: preserved };
      } else {
        lastResearchResult = { ok: false, preserved: false, error: error.message };
      }
      await appendResearchLog({
        status: "failed",
        error: error.message,
        duration_ms: Date.now() - started
      });
      return lastResearchResult;
    } finally {
      researchInFlight = null;
    }
  })();

  return researchInFlight;
}

export function getLastResearchResult() {
  return lastResearchResult;
}

export async function getResearchStatus(config) {
  const catalog = await loadResearchCatalog();
  const researchConfig = mergeResearchAgentConfig(config?.routing?.smartRoute ?? {});
  const ageHours = catalog?.generated_at
    ? (Date.now() - Date.parse(catalog.generated_at)) / 3_600_000
    : Infinity;
  const stale = !catalog || catalog.stale || ageHours > researchConfig.maxSourceAgeHours;

  return {
    enabled: researchConfig.enabled,
    stale,
    age_hours: Number.isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null,
    max_source_age_hours: researchConfig.maxSourceAgeHours,
    research_hash: catalog?.research_hash ?? null,
    generated_at: catalog?.generated_at ?? null,
    refresh_status: catalog?.refresh_status ?? "missing",
    coverage: catalog?.coverage ?? summarizeResearchCoverage(catalog),
    source_failures: catalog?.source_failures ?? [],
    sources_fetched: catalog?.sources_fetched ?? [],
    price_changes: catalog?.price_changes ?? [],
    requires_review: catalog?.requires_review ?? [],
    invalid_pricing_count: catalog?.invalid_pricing?.length ?? 0,
    paths: RESEARCH_PATHS,
    last_result: lastResearchResult
  };
}

function dedupeModels(models) {
  const byId = new Map();
  for (const row of models) {
    if (!row?.canonical_id) continue;
    byId.set(row.canonical_id, row);
  }
  return [...byId.values()];
}

/** Official published rates for known models missing from live extraction. */
function bootstrapOfficialPricing(existing) {
  const haveId = new Set(
    existing.filter((r) => r.pricing_status === "valid").map((r) => r.canonical_id)
  );
  const now = new Date().toISOString();
  const out = [];

  const add = (provider, model, input, output, url) => {
    const canonical_id = `${provider}:${model}`;
    if (haveId.has(canonical_id)) return;
    out.push({
      provider,
      model,
      canonical_id,
      route_context: "direct_provider",
      input_per_1m: input,
      output_per_1m: output,
      pricing_unit: "per_1m_tokens",
      currency: "USD",
      source_url: url,
      source_authority: "official_pricing",
      source_hash: null,
      fetched_at: now,
      parsed_at: now,
      confidence: 0.7,
      extraction_method: "static_official_table",
      evidence_label: "bootstrap_official_table",
      pricing_status: "valid",
      pricing_source: "official_pricing"
    });
  };

  const openaiUrl = "https://openai.com/api/pricing/";
  add("openai", "gpt-4o", 2.5, 10, openaiUrl);
  add("openai", "gpt-4o-mini", 0.15, 0.6, openaiUrl);
  add("openai", "gpt-5.4", 2.5, 15, openaiUrl);
  add("openai", "gpt-5.4-mini", 0.75, 4.5, openaiUrl);
  add("openai", "gpt-5-mini", 0.25, 2, openaiUrl);

  const anthropicUrl = "https://platform.claude.com/docs/en/about-claude/pricing";
  add("anthropic", "claude-opus-4-6", 15, 75, anthropicUrl);
  add("anthropic", "claude-sonnet-4-6", 3, 15, anthropicUrl);
  add("anthropic", "claude-haiku-4-5", 0.8, 4, anthropicUrl);

  const geminiUrl = "https://ai.google.dev/gemini-api/docs/pricing";
  add("google", "gemini-2.5-flash", 0.15, 0.6, geminiUrl);
  add("google", "gemini-2.5-pro", 1.25, 5, geminiUrl);

  return out;
}
