/**
 * Normalized model+capability registry (PARAGON-D-004).
 *
 * Built from real discovery (listModels()/runStatus() against the actual
 * installed CLIs and HTTP providers) plus a small, explicitly-labeled set
 * of heuristics for fields no CLI exposes directly (cost/latency class,
 * context window). Unknown stays unknown — nothing here is fabricated to
 * look more complete than it is.
 */

import { listCatalogEntries } from "../modelCatalog.js";

// Context windows are only filled in where there's a well-documented public
// spec for the model family. Everything else stays null (unknown) rather
// than guessed.
const KNOWN_CONTEXT_WINDOWS = [
  { pattern: /^claude-/, tokens: 200000 },
  { pattern: /^gpt-5/, tokens: 400000 },
  { pattern: /^gpt-oss/, tokens: 131072 }
];

function inferContextWindow(modelId) {
  const found = KNOWN_CONTEXT_WINDOWS.find((entry) => entry.pattern.test(modelId));
  return found ? found.tokens : null;
}

// Naming-pattern heuristic only — not a benchmark result. Used purely as a
// coarse, operator-overridable default; never presented as measured fact.
const ECONOMY_HINTS = /haiku|mini|flash|-low\b|small/i;
const PREMIUM_HINTS = /opus|mythos|fable|-pro\b|-high\b|-max\b|ultra/i;

function inferCostClass(modelId) {
  if (ECONOMY_HINTS.test(modelId)) return "economy";
  if (PREMIUM_HINTS.test(modelId)) return "premium";
  return "standard";
}

function inferLatencyClass(costClass) {
  // Coarse correlation only (bigger/premium models tend to run slower) —
  // not a measured latency figure. Real measured latency (from telemetry)
  // should always be preferred over this once available; see
  // attachPerformanceEvidence() in router.js.
  if (costClass === "economy") return "fast";
  if (costClass === "premium") return "slow";
  return "medium";
}

/**
 * Builds one registry entry per (provider, model). `statuses` is the same
 * shape /api/status already returns — reused rather than re-probed, so
 * building the registry never triggers extra CLI spawns.
 *
 * `catalog` (PARAGON-D-004C) is the persisted model-catalog store from
 * src/modelCatalog.js. When supplied, automaticEligibility for a provider
 * that the catalog has actually assessed at least once (it has a bucket in
 * catalog.providers) is gated on the catalog's real state machine
 * (exposed/validated within TTL only) instead of being assumed true for
 * anything sitting in providerConfig.models — that config list is only the
 * operator's last "Load models" snapshot, not evidence of current
 * availability. A provider the catalog has *never* assessed (no bucket at
 * all — e.g. just configured, before the scheduler's first pass has run)
 * falls back to trusting providerConfig.models so a freshly-added provider
 * isn't dead on arrival; the very next scheduled/manual refresh replaces
 * that trust with real evidence. Callers that omit `catalog` entirely
 * (existing unit tests, or code paths not wired to the catalog store) keep
 * the pre-D-004C behavior of trusting providerConfig.models directly —
 * every real request/dashboard path in server.js and openaiApi.js always
 * passes the live catalog.
 */
export function buildModelRegistry(config, statuses = {}, catalog = null) {
  const entries = [];
  const now = new Date().toISOString();
  const ttlHours = config.modelCatalog?.validationTtlHours ?? 24;

  for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
    if (!providerConfig.enabled) {
      continue;
    }
    const health = statuses[provider]?.ok === true ? "healthy" : statuses[provider] ? "unhealthy" : "unknown";
    const providerAssessed = Boolean(catalog?.providers && Object.prototype.hasOwnProperty.call(catalog.providers, provider));
    const catalogEntries = providerAssessed ? listCatalogEntries(catalog, provider, { ttlHours }) : null;
    const models = catalogEntries
      ? catalogEntries
      : providerConfig.models?.length
        ? providerConfig.models
        : [{ id: providerConfig.model || "", name: providerConfig.model || "(default)" }];

    for (const model of models) {
      const modelId = model.modelId ?? model.id;
      if (!modelId) {
        continue;
      }
      const costClass = inferCostClass(modelId);
      entries.push({
        provider,
        model: modelId,
        displayName: model.displayName || model.name || modelId,
        health,
        local: providerConfig.type === "http",
        contextWindow: inferContextWindow(modelId),
        capabilities: {
          // All current providers are coding-agent CLIs/HTTP completion
          // backends — these two are inherent to what they are, not
          // inferred from a benchmark.
          coding: true,
          tools: true,
          streaming: true,
          // No verified per-model reasoning benchmark exists for these
          // CLIs — left explicitly unknown rather than guessed.
          reasoning: "unknown"
        },
        costClass,
        latencyClass: inferLatencyClass(costClass),
        // PARAGON-D-004B-R: PARAGON is a transparent model gateway, not an
        // autonomous repo-editing agent — every builtin provider runs
        // read-only/tools-disabled in a throwaway isolated directory (see
        // src/cli.js providerSpecs and src/executionSandbox.js). Tool-risk
        // is never a reason to exclude a model. PARAGON-D-004C:
        // automaticEligibility is the catalog's validated/exposed state
        // when a catalog is supplied — see the doc comment above — not an
        // unconditional true.
        automaticEligibility: catalogEntries ? Boolean(model.automaticEligibility) : true,
        toolExecutionRisk: "isolated",
        source: catalogEntries ? model.discoverySource : providerConfig.models?.length ? "discovered" : "configured",
        modelState: catalogEntries ? model.state : undefined,
        catalogAgeHours: catalogEntries && model.validatedAt ? (Date.now() - Date.parse(model.validatedAt)) / 3_600_000 : undefined,
        lastDiscoveryAt: catalogEntries ? model.discoveredAt : now
      });
    }
  }

  return entries;
}
