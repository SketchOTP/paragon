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
import { classifyChatCapability, isProviderDefaultId } from "../modelCapability.js";

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
 * src/modelCatalog.js. A provider only contributes registry entries for
 * models the catalog currently considers `exposed` or `validated` (within
 * TTL) — an unvalidated, rejected, unavailable, blocked, or retired model
 * is left out entirely, not merely marked ineligible. The registry (and
 * everything built on it: the ranking algorithm, the dashboard Model
 * Routing panel, and the live per-request routing decision) is the single
 * source of truth for "what can PARAGON route to right now," so it must
 * never list a model routing can't actually use. It is recomputed fresh on
 * every call (no caching), so a completed catalog refresh is reflected
 * immediately — there is no separate "refresh the registry" step.
 *
 * PARAGON-D-004C1 (P0-4) removed the previous unassessed-provider
 * fallback. Before this change, a provider with no catalog bucket fell
 * back to trusting `providerConfig.models`, which put six never-validated
 * LM Studio models — including two embedding models — into the live
 * routable registry with `automaticEligibility: true`. A provider with no
 * completed assessment is now reported as `pending_assessment` with
 * `automaticEligibility: false` and contributes zero routable entries; a
 * *failed* refresh leaves it unavailable rather than trusted. `catalog`
 * is therefore effectively required for any provider to be routable —
 * callers that omit it get an empty registry rather than silent
 * config-trust.
 *
 * PARAGON-D-004C1 (P0-5) additionally drops any model positively
 * identified as non-chat (see src/modelCapability.js), since PARAGON's
 * only public surface is chat completions.
 */
export function buildModelRegistry(config, statuses = {}, catalog = null) {
  const entries = [];
  const ttlHours = config.modelCatalog?.validationTtlHours ?? 24;

  for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
    if (!providerConfig.enabled) {
      continue;
    }
    const health = statuses[provider]?.ok === true ? "healthy" : statuses[provider] ? "unhealthy" : "unknown";
    const providerAssessed = Boolean(catalog?.providers && Object.prototype.hasOwnProperty.call(catalog.providers, provider));

    if (!providerAssessed) {
      // Reported so the dashboard can show *why* the provider is dark,
      // but deliberately never eligible and never a routing candidate.
      entries.push({
        provider,
        model: null,
        displayName: providerConfig.label || provider,
        health,
        local: providerConfig.type === "http",
        contextWindow: null,
        capabilities: { chatCompletions: "unknown" },
        costClass: "unknown",
        latencyClass: "unknown",
        automaticEligibility: false,
        toolExecutionRisk: "isolated",
        source: "pending_assessment",
        modelState: "pending_assessment",
        pendingAssessment: true,
        catalogAgeHours: undefined,
        lastDiscoveryAt: null
      });
      continue;
    }

    const catalogEntries = listCatalogEntries(catalog, provider, { ttlHours }).filter((entry) => entry.automaticEligibility);

    for (const model of catalogEntries) {
      const modelId = model.modelId;
      if (!modelId) {
        continue;
      }
      const chatCapability = classifyChatCapability({ modelId, metadata: model.metadata });
      if (chatCapability === "unsupported") {
        continue;
      }
      const providerDefault = isProviderDefaultId(modelId);
      const costClass = providerDefault ? "unknown" : inferCostClass(modelId);
      entries.push({
        provider,
        model: modelId,
        displayName: model.displayName || modelId,
        health,
        local: providerConfig.type === "http",
        contextWindow: providerDefault ? null : inferContextWindow(modelId),
        capabilities: {
          // P0-5: the only capability this hotfix asserts. Tool-call,
          // JSON-schema, multimodal, and reasoning profiles are D-004D
          // scope and deliberately not guessed at here.
          chatCompletions: chatCapability === "supported" ? true : "unknown"
        },
        costClass,
        latencyClass: providerDefault ? "unknown" : inferLatencyClass(costClass),
        // PARAGON-D-004B-R: every builtin provider runs
        // read-only/tools-disabled in a throwaway isolated directory (see
        // src/cli.js providerSpecs and src/executionSandbox.js), so
        // tool-risk is never a reason to exclude a model. Eligibility here
        // is purely the catalog's exposed/validated state.
        automaticEligibility: true,
        toolExecutionRisk: "isolated",
        source: model.discoverySource,
        modelState: model.state,
        providerDefault,
        catalogAgeHours: model.validatedAt ? (Date.now() - Date.parse(model.validatedAt)) / 3_600_000 : undefined,
        lastDiscoveryAt: model.discoveredAt
      });
    }
  }

  return entries;
}
