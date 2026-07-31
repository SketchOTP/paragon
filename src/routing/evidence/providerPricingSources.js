export const STATIC_PRICING_SOURCE = "static_fallback";
export function providerPricing({ provider, modelId, openRouterModels = [], official = {} } = {}) {
  if (provider === "openrouter") {
    const row = openRouterModels.find((m) => m.id === modelId);
    if (!row) return null;
    return { inputPerToken: Number(row.pricing?.prompt), outputPerToken: Number(row.pricing?.completion), source: "openrouter_models_api", confidence: "high", asOf: new Date().toISOString() };
  }
  const row = official[provider]?.[modelId];
  return row ? { ...row, source: row.source ?? "provider_official", confidence: row.confidence ?? "medium" } : null;
}
