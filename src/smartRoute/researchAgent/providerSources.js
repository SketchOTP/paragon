import { readJson, RESEARCH_PATHS } from "./sourceSnapshotStore.js";

export async function loadProviderSources() {
  const sources = await readJson(RESEARCH_PATHS.providerSources, {});
  return sources;
}

export function listPricingSources(registry) {
  const out = [];
  for (const [provider, groups] of Object.entries(registry ?? {})) {
    for (const source of groups.pricing ?? []) {
      out.push({ provider, kind: "pricing", ...source });
    }
  }
  return out;
}

export function listAvailabilitySources(registry) {
  const out = [];
  for (const [provider, groups] of Object.entries(registry ?? {})) {
    for (const source of groups.availability ?? []) {
      out.push({ provider, kind: "availability", ...source });
    }
  }
  return out;
}

export function listBenchmarkSources(registry) {
  const out = [];
  for (const [provider, groups] of Object.entries(registry ?? {})) {
    for (const source of groups.benchmarks ?? []) {
      out.push({ provider, kind: "benchmarks", ...source });
    }
  }
  return out;
}

export const DEFAULT_RESEARCH_AGENT = {
  enabled: true,
  schedule: "0 2 * * *",
  timezone: "America/New_York",
  maxSourceAgeHours: 36,
  requireOfficialPricingForDirectProviders: true,
  allowAggregatorPricingForAggregatorRoutes: true,
  requireSourceSnapshots: true,
  llmExtractionEnabled: false,
  reviewLargePriceChanges: true,
  largePriceChangePercent: 25
};

export function mergeResearchAgentConfig(smartRoute = {}) {
  return { ...DEFAULT_RESEARCH_AGENT, ...(smartRoute.researchAgent ?? {}) };
}
