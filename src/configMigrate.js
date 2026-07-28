import { CONFIG_VERSION, LEGACY_EXPOSED_MODEL_ALIAS, defaultConfig } from "./defaultConfig.js";

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
 * PARAGON-D-003R: shadow mode is retired. Any config still carrying the
 * legacy "shadow" mode value is migrated to "live" in place — this is not
 * a rename, since "live" now actually enforces (see
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
