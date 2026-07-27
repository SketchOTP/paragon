/**
 * Extract model availability from API / docs sources.
 */

export function extractModelsFromSource(fetchResult, config = {}) {
  if (!fetchResult?.ok) {
    return { models: [], error: fetchResult?.error ?? "fetch_failed" };
  }

  const provider = fetchResult.provider;
  const now = new Date().toISOString();

  if (provider === "openrouter" && fetchResult.json) {
    const rows = fetchResult.json.data ?? fetchResult.json.models ?? [];
    return {
      models: rows
        .map((row) => {
          const id = row.id ?? row.name;
          if (!id) return null;
          return {
            provider: "openrouter",
            model: id,
            canonical_id: `openrouter:${id}`,
            availability_source: "api_list",
            available: true,
            source_url: fetchResult.url,
            source_hash: fetchResult.snapshot?.source_hash ?? null,
            fetched_at: now,
            context_length: row.context_length ?? null
          };
        })
        .filter(Boolean),
      error: null
    };
  }

  if (provider === "openai" && fetchResult.json) {
    const rows = fetchResult.json.data ?? [];
    return {
      models: rows
        .map((row) => {
          const id = row.id;
          if (!id) return null;
          return {
            provider: "openai",
            model: id,
            canonical_id: `openai:${id}`,
            availability_source: "account_api",
            available: true,
            source_url: fetchResult.url,
            source_hash: fetchResult.snapshot?.source_hash ?? null,
            fetched_at: now
          };
        })
        .filter(Boolean),
      error: null
    };
  }

  // Configured models for probe-style providers
  if (fetchResult.source?.type?.includes("configured")) {
    return { models: configuredModels(provider, config, now), error: null };
  }

  return { models: [], error: "no_models_extracted" };
}

export function configuredModels(providerKey, config, now = new Date().toISOString()) {
  const map = {
    anthropic: "claude",
    google_gemini: "antigravity",
    openai: "openai"
  };
  const configKey = map[providerKey] ?? providerKey;
  const providerConfig = config?.providers?.[configKey];
  if (!providerConfig) return [];

  const models = providerConfig.models?.length
    ? providerConfig.models.map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean)
    : [providerConfig.model].filter(Boolean);

  return models.map((model) => ({
    provider: configKey,
    model,
    canonical_id: `${configKey}:${model}`,
    availability_source: "configured",
    available: true,
    source_url: null,
    source_hash: null,
    fetched_at: now
  }));
}
