import { getResearchStatus } from "./researchRefresh.js";
import { loadBenchmarkEvidence, loadPricingEvidence, loadResearchCatalog } from "./researchCatalog.js";

export async function buildResearchReport(config) {
  const status = await getResearchStatus(config);
  const catalog = await loadResearchCatalog();
  const pricingEvidence = await loadPricingEvidence();
  const benchmarkEvidence = await loadBenchmarkEvidence();

  return {
    ...status,
    models_discovered: catalog?.models?.length ?? 0,
    pricing_rows: Object.keys(pricingEvidence).length,
    benchmark_rows: Object.keys(benchmarkEvidence).length,
    invalid_pricing: (catalog?.invalid_pricing ?? []).slice(0, 20),
    requires_manual_review: (catalog?.requires_review ?? []).slice(0, 20),
    sample_evidence: Object.values(pricingEvidence)
      .slice(0, 10)
      .map((row) => ({
        canonical_id: row.canonical_id,
        route_context: row.route_context,
        input_per_1m: row.input_per_1m,
        output_per_1m: row.output_per_1m,
        source_url: row.source_url,
        source_authority: row.source_authority,
        source_hash: row.source_hash,
        confidence: row.confidence,
        pricing_status: row.pricing_status
      }))
  };
}

export async function getPricingEvidenceForModel(canonicalId) {
  const evidence = await loadPricingEvidence();
  return evidence[canonicalId] ?? null;
}

export async function getBenchmarkEvidenceForModel(canonicalId) {
  const evidence = await loadBenchmarkEvidence();
  return evidence[canonicalId] ?? null;
}
