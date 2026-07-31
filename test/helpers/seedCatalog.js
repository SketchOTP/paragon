import fs from "node:fs";
import path from "node:path";
import { defaultCatalog, replaceProviderModels } from "../../src/modelCatalog.js";

/**
 * Writes a persisted model-catalog file into a test server's cwd before the
 * server starts.
 *
 * PARAGON-D-004C1 (P0-4) removed the unassessed-provider config-trust
 * fallback: a provider with no catalog bucket contributes zero routable
 * models, so an integration test that only PUTs provider config now
 * (correctly) gets `503 no_eligible_model`. Seeding the real persisted
 * catalog is the honest way to give a fixture provider routable models —
 * it exercises the same load path production uses, rather than adding a
 * test-only bypass to the server.
 *
 * @param {string} cwd - the directory the server is spawned in
 * @param {Record<string, string[]>} providerModels - { providerName: [modelId, ...] }
 */
export function seedCatalogFile(cwd, providerModels) {
  const catalog = defaultCatalog();
  catalog.generation = 1;
  for (const [provider, modelIds] of Object.entries(providerModels)) {
    replaceProviderModels(
      catalog,
      provider,
      modelIds.map((modelId) => ({
        modelId,
        displayName: modelId,
        state: "validated",
        discoverySource: "documented_candidate",
        // Test-only published price so fixture providers exercise routing;
        // production candidates must carry vendor/OpenRouter pricing.
        metadata: { context_length: 400000, pricing: { prompt: "0.000001", completion: "0.000003" } }
      }))
    );
  }
  const now = new Date().toISOString();
  catalog.schedule = {
    refreshing: false,
    lastRefreshStartedAt: now,
    lastRefreshCompletedAt: now,
    lastSuccessfulRefreshAt: now,
    nextRefreshAt: new Date(Date.now() + 24 * 3_600_000).toISOString()
  };
  const dataDir = path.join(cwd, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "model-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return catalog;
}
