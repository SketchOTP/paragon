import fs from "node:fs/promises";
import path from "node:path";
import { generateApiKey } from "./auth.js";
import {
  migrateOrchestrationMode,
  migrateRoutingSchema,
  migrateToParagon,
  needsRoutingSchemaMigration
} from "./configMigrate.js";
import { BUILTIN_PROVIDERS, defaultConfig } from "./defaultConfig.js";
import { getEnv } from "./env.js";
import { mergeOrchestrationConfig } from "./orchestration/governorPolicy.js";

const dataDir = path.resolve(process.cwd(), "data");
const configPath = path.join(dataDir, "config.json");

function mergeProviders(baseProviders, incomingProviders) {
  const merged = {};
  const keys = new Set([...Object.keys(baseProviders ?? {}), ...Object.keys(incomingProviders ?? {})]);

  for (const key of keys) {
    merged[key] = {
      ...(baseProviders?.[key] ?? {}),
      ...(incomingProviders?.[key] ?? {})
    };
  }
  return merged;
}

export function mergeConfig(base, incoming) {
  return {
    ...base,
    ...incoming,
    server: { ...base.server, ...incoming?.server },
    providers: mergeProviders(base.providers, incoming?.providers),
    routing: { ...base.routing, ...incoming?.routing },
    automaticRouting: { ...base.automaticRouting, ...incoming?.automaticRouting },
    orchestration: mergeOrchestrationConfig(base.orchestration, incoming?.orchestration),
    integrations: { ...base.integrations, ...incoming?.integrations }
  };
}

function applyEnvOverrides(config) {
  const apiKey = getEnv("API_KEY");
  if (apiKey) {
    config.server.apiKey = apiKey;
  }
  const host = getEnv("HOST");
  if (host) {
    config.server.host = host;
  }
  const port = getEnv("PORT");
  if (port) {
    config.server.port = Number(port);
  }
  // Escape hatch for test/dev process spawns that must not trigger real
  // provider probes just by starting the server (see
  // src/modelCatalogScheduler.js) — production deployments never set this.
  const modelCatalogEnabled = getEnv("MODEL_CATALOG_ENABLED");
  if (modelCatalogEnabled !== undefined) {
    config.modelCatalog = { ...config.modelCatalog, enabled: modelCatalogEnabled !== "0" && modelCatalogEnabled !== "false" };
  }
  return config;
}

async function ensureApiKey(config, persist) {
  if (getEnv("API_KEY") || config.server.apiKey) {
    return config;
  }
  const next = {
    ...config,
    server: { ...config.server, apiKey: generateApiKey() }
  };
  if (persist) {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log("Generated PARAGON API key (saved to data/config.json)");
    console.log(`  ${next.server.apiKey}`);
  }
  return next;
}

/**
 * Writes a timestamped, full copy of the config exactly as it exists on disk,
 * before anything rewrites it. This is the rollback artifact the activation
 * gate requires: Git covers code, this covers the operator's own state.
 *
 * Returns the backup path, or null when there was nothing to back up. A
 * backup failure is fatal to the migration by design — migrating without a
 * rollback point is the one thing the directive forbids outright.
 */
export async function backupConfigFile(rawContents, { now = new Date() } = {}) {
  if (!rawContents) {
    return null;
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dataDir, `config.backup.${stamp}.json`);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(backupPath, rawContents, "utf8");
  return backupPath;
}

/**
 * Runs the v3 routing-schema migration atomically: back up the original file,
 * log every removed field and its previous value, then write the migrated
 * config through the normal atomic path. Nothing is removed before the backup
 * exists on disk.
 */
async function applyRoutingSchemaMigration(config, rawContents) {
  const { config: migrated, removed, changed } = migrateRoutingSchema(config);
  if (!changed) {
    return config;
  }

  const backupPath = await backupConfigFile(rawContents);
  if (backupPath) {
    console.log(`PARAGON config migration: backed up previous config to ${backupPath}`);
  }
  for (const entry of removed) {
    console.log(
      `PARAGON config migration: removed ${entry.path} (was ${JSON.stringify(entry.previousValue)}) — superseded by automatic routing`
    );
  }

  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
  await fs.rename(tmp, configPath);
  console.log(`PARAGON config migration: schema now at version ${migrated.configVersion}`);
  return migrated;
}

export async function readConfig() {
  let config;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    config = mergeConfig(defaultConfig, parsed);
    config = migrateToParagon(migrateOrchestrationMode(config));
    // Migrate against the *parsed file*, not the default-merged view: merging
    // would have already supplied v3 defaults and hidden the legacy fields.
    if (needsRoutingSchemaMigration(parsed)) {
      config = await applyRoutingSchemaMigration(config, raw);
    }
    config = await ensureApiKey(config, false);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read config, using defaults: ${error.message}`);
    }
    config = mergeConfig(defaultConfig, {});
    config = migrateToParagon(migrateOrchestrationMode(config));
    config = await ensureApiKey(config, true);
  }
  return applyEnvOverrides(config);
}

export async function writeConfig(nextConfig) {
  const merged = migrateToParagon(migrateOrchestrationMode(mergeConfig(defaultConfig, nextConfig)));
  // A dashboard save must not be able to reintroduce a removed field, whatever
  // the client posted.
  const { config: sanitized } = migrateRoutingSchema(merged);
  await fs.mkdir(dataDir, { recursive: true });
  // Atomic: a crash mid-write must never truncate the operator's config.
  const tmp = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  await fs.rename(tmp, configPath);
  return applyEnvOverrides(sanitized);
}

export { BUILTIN_PROVIDERS, configPath, dataDir };
