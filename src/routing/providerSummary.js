/**
 * Per-provider routing summary (PARAGON-D-004D1, Phase 1).
 *
 * Replaces the provider card's `Model` dropdown. That control wrote
 * `providers[x].model` and read as "the model this provider will use", which
 * has not been true since PARAGON-D-004C1: live attempts are built from
 * ranked, catalog-eligible registry entries, and dispatch may not substitute
 * `providerConfig.model` at all.
 *
 * What replaces it is a count, not a choice — how many models the provider
 * currently contributes to routing, in what states, when that was last
 * established, and which model was actually used last. Every field here is
 * derived from the live catalog plus observed activity; nothing is a stored
 * operator preference.
 *
 * Pure function over already-loaded state: no provider calls, no I/O.
 */

import { isEligibleNow, listCatalogEntries } from "../modelCatalog.js";
import { classifyChatCapability, isProviderDefaultId, PROVIDER_DEFAULT_MODEL_ID } from "../modelCapability.js";

/**
 * States rolled up as "blocked" on the card. Distinct from `retired`, which
 * is catalog history (a model that vanished from a later authoritative
 * discovery) rather than a model that failed.
 */
const BLOCKED_STATES = new Set([
  "rejected",
  "unavailable",
  "authentication_blocked",
  "quota_blocked",
  "entitlement_blocked",
  "configuration_blocked",
  "provider_offline"
]);

function healthOf(statuses, provider) {
  if (statuses?.[provider]?.ok === true) {
    return "healthy";
  }
  return statuses?.[provider] ? "unhealthy" : "unknown";
}

/**
 * Builds one summary per configured provider — including disabled ones, so
 * the card can say "disabled" rather than silently showing zeros that look
 * like a failure.
 */
export function buildProviderRoutingSummaries(
  config,
  statuses = {},
  catalog = null,
  activity = null,
  { ttlHours: ttlOverride, now = Date.now(), quotaState = null } = {}
) {
  const ttlHours = ttlOverride ?? config?.modelCatalog?.validationTtlHours ?? 24;
  const summaries = [];

  for (const [provider, providerConfig] of Object.entries(config?.providers ?? {})) {
    const assessed = Boolean(catalog?.providers && Object.prototype.hasOwnProperty.call(catalog.providers, provider));
    const bucket = assessed ? catalog.providers[provider] : null;
    const entries = assessed ? listCatalogEntries(catalog, provider, { ttlHours, now }) : [];

    let eligible = 0;
    let validated = 0;
    let exposed = 0;
    let blocked = 0;
    let retired = 0;
    let candidateOnly = 0;
    let stale = 0;
    let providerDefaultValidated = false;

    for (const entry of entries) {
      if (entry.state === "validated") validated += 1;
      else if (entry.state === "exposed") exposed += 1;
      else if (entry.state === "retired") retired += 1;
      else if (entry.state === "unknown") candidateOnly += 1;
      else if (entry.state === "stale") stale += 1;
      if (BLOCKED_STATES.has(entry.state)) blocked += 1;

      // Mirrors buildModelRegistry(): eligibility is the catalog rule AND the
      // chat-capability gate, so this count can never exceed what routing
      // will actually consider.
      if (entry.automaticEligibility && classifyChatCapability({ modelId: entry.modelId, metadata: entry.metadata }) !== "unsupported") {
        eligible += 1;
        if (isProviderDefaultId(entry.modelId)) {
          providerDefaultValidated = true;
        }
      }
    }

    const defaultEntry = bucket?.models?.[PROVIDER_DEFAULT_MODEL_ID] ?? null;

    summaries.push({
      provider,
      label: providerConfig?.label || provider,
      enabled: Boolean(providerConfig?.enabled),
      type: providerConfig?.type ?? "builtin",
      health: healthOf(statuses, provider),
      // "pending_assessment" is the honest state for an enabled provider with
      // no completed discovery — it contributes zero routable models and is
      // never trusted from config (D-004C1 P0-4).
      catalogState: !providerConfig?.enabled ? "disabled" : assessed ? "assessed" : "pending_assessment",
      pendingAssessment: Boolean(providerConfig?.enabled) && !assessed,
      counts: {
        total: entries.length,
        eligible,
        validated,
        exposed,
        blocked,
        retired,
        stale,
        candidateOnly
      },
      lastDiscoveryAt: bucket?.lastDiscoveryAt ?? null,
      lastSuccessfulRefreshAt: catalog?.schedule?.lastSuccessfulRefreshAt ?? null,
      nextRefreshAt: catalog?.schedule?.nextRefreshAt ?? null,
      cliVersion: bucket?.cliVersion ?? null,
      /**
       * Whether letting the provider pick its own model is itself a validated
       * path. `false` here does not mean "broken" — most providers expose
       * explicit model ids and never register a provider-default entry.
       */
      providerDefault: {
        present: Boolean(defaultEntry),
        state: defaultEntry?.state ?? null,
        validated: providerDefaultValidated,
        eligible: defaultEntry ? isEligibleNow(defaultEntry, { ttlHours, now }) : false
      },
      /** The provider-model that actually returned a response most recently. */
      lastExecutedModel: activity?.lastExecuted?.(provider) ?? null,
      /** The most recent failure, kept distinct so a failure is never shown as usage. */
      lastFailure: activity?.lastFailure?.(provider) ?? null,
      /**
       * Present only while the provider's allowance is observably spent, with
       * the reset instant when the provider told us one. This is what turns a
       * card from "Ready" into "Needs attention" for a quota condition.
       */
      usageLimit: quotaState?.state?.(provider) ?? null,
      selection: "automatic-per-request"
    });
  }

  return summaries;
}
