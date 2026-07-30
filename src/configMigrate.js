import { CONFIG_VERSION, LEGACY_EXPOSED_MODEL_ALIAS, defaultConfig } from "./defaultConfig.js";
import { normalizeRoutingPriority } from "./routing/routingPriority.js";

/**
 * RouterBot -> PARAGON identity migration.
 * Idempotent: safe to run on every config load. Only touches the
 * exposedModel field when it still holds the pre-rename default, and only
 * bumps configVersion — it never discards or rewrites unrelated user
 * settings, credentials, or provider configuration.
 */
export function migrateToParagon(config) {
  const fromVersion = config.configVersion ?? 1;
  if (fromVersion >= CONFIG_VERSION && config.server?.exposedModel !== LEGACY_EXPOSED_MODEL_ALIAS) {
    return config;
  }

  const next = {
    ...config,
    configVersion: CONFIG_VERSION,
    server: { ...config.server }
  };

  if (next.server.exposedModel === LEGACY_EXPOSED_MODEL_ALIAS) {
    next.server.exposedModel = defaultConfig.server.exposedModel;
  }

  return next;
}

/**
 * Orchestration shadow mode is retired. Any config still carrying the legacy
 * "shadow" mode value is migrated to "live" in place — this is not a rename,
 * since "live" now actually enforces (see
 * src/orchestration/liveEnforcement.js). Idempotent: a config already on
 * "off" or "live" is returned unchanged.
 */
export function migrateOrchestrationMode(config) {
  if (config?.orchestration?.mode !== "shadow") {
    return config;
  }
  return {
    ...config,
    orchestration: { ...config.orchestration, mode: "live" }
  };
}

/**
 * Fields this migration removes, with what supersedes each. Exported so the
 * migration log and the evidence report describe the same set, and so a test
 * can assert the schema no longer carries any of them.
 */
export const REMOVED_ROUTING_FIELDS = [
  {
    path: "providers.*.model",
    supersededBy: "per-request selection from the ranked eligible catalog",
    reason: "a stored model preference could only ever disagree with the model that actually runs"
  },
  {
    path: "routing.defaultProvider",
    supersededBy: "bounded 503 no_eligible_model",
    reason: "there is no static fallback route; availability is never preserved by weakening a gate"
  },
  {
    path: "routing.fallbackChain",
    supersededBy: "the per-request ranked attempt plan",
    reason: "fallback order is derived from live eligibility, not a saved list"
  },
  {
    path: "routing.taskRoutes",
    supersededBy: "routing.priority",
    reason: "the expected-utility router consumes no provider preference; seven task mappings are not translatable into it"
  },
  {
    path: "routingIntelligence.mode",
    supersededBy: "nothing — there is one routing engine and it always executes",
    reason: "a runtime switch between two engines is exactly what this release removes"
  },
  {
    path: "routingIntelligence.shadowRecordLimit",
    supersededBy: "nothing — no shadow records are produced",
    reason: "the shadow record store no longer exists"
  }
];

/** True when `config` still carries any schema element this migration removes. */
export function needsRoutingSchemaMigration(config) {
  if (!config || typeof config !== "object") {
    return false;
  }
  if ((config.configVersion ?? 1) < CONFIG_VERSION) {
    return true;
  }
  if (config.routingIntelligence) {
    return true;
  }
  const routing = config.routing ?? {};
  if (routing.defaultProvider !== undefined || routing.fallbackChain !== undefined || routing.taskRoutes !== undefined) {
    return true;
  }
  return Object.values(config.providers ?? {}).some((provider) => provider && provider.model !== undefined);
}

/**
 * PARAGON-D-004E (Phase 4): removes the legacy routing schema.
 *
 * Deliberately a **removal**, not a translation. The seven task-provider
 * mappings in `routing.taskRoutes` have no honest equivalent in the
 * expected-utility model — silently converting "code -> codex" into a utility
 * bonus would reintroduce the provider preference this release exists to
 * delete, while quietly claiming the operator asked for it. The old values are
 * recorded in the migration log and in the pre-migration backup instead.
 *
 * Pure: the caller (configStore) is responsible for writing the backup before
 * persisting the result. Idempotent — a v3 config passes through unchanged.
 *
 * @returns {{ config: object, removed: object[], changed: boolean }}
 */
export function migrateRoutingSchema(config) {
  if (!needsRoutingSchemaMigration(config)) {
    return { config, removed: [], changed: false };
  }

  const removed = [];
  const next = { ...config, configVersion: CONFIG_VERSION };

  // --- providers.*.model
  const providers = {};
  for (const [name, providerConfig] of Object.entries(config.providers ?? {})) {
    if (providerConfig && providerConfig.model !== undefined) {
      if (providerConfig.model) {
        removed.push({ path: `providers.${name}.model`, previousValue: providerConfig.model });
      }
      // Everything else on the provider is preserved verbatim: credentials,
      // baseUrl, apiKey, command, enabled, avatar, timeouts, discovered models.
      const { model, ...rest } = providerConfig;
      providers[name] = rest;
    } else {
      providers[name] = providerConfig;
    }
  }
  next.providers = providers;

  // --- routing.*
  const routing = { ...(config.routing ?? {}) };
  for (const field of ["defaultProvider", "fallbackChain", "taskRoutes"]) {
    if (routing[field] !== undefined) {
      removed.push({ path: `routing.${field}`, previousValue: routing[field] });
      delete routing[field];
    }
  }
  routing.priority = normalizeRoutingPriority(routing.priority);
  next.routing = routing;

  // --- routingIntelligence -> automaticRouting
  if (config.routingIntelligence) {
    const { mode, shadowRecordLimit, quotaScarcity, ...carried } = config.routingIntelligence;
    if (mode !== undefined) {
      removed.push({ path: "routingIntelligence.mode", previousValue: mode });
    }
    if (shadowRecordLimit !== undefined) {
      removed.push({ path: "routingIntelligence.shadowRecordLimit", previousValue: shadowRecordLimit });
    }
    if (quotaScarcity !== undefined) {
      // Superseded by scarcity observed from real quota failures.
      removed.push({ path: "routingIntelligence.quotaScarcity", previousValue: quotaScarcity });
    }
    // Operator-reviewed mapping tables and bounds are genuinely still used by
    // the one live engine, so they carry across rather than being discarded.
    next.automaticRouting = { ...(config.automaticRouting ?? {}), ...carried };
    delete next.routingIntelligence;
  }

  return { config: next, removed, changed: true };
}
