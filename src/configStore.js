import fs from "node:fs/promises";
import path from "node:path";
import { generateApiKey } from "./auth.js";
import { effectiveCursorBaseUrl, reconcilePersistedCursorBaseUrl } from "./cursorBaseUrl.js";
import { migrateGeminiToAntigravity } from "./configMigrate.js";
import { BUILTIN_PROVIDERS, defaultConfig } from "./defaultConfig.js";
import { getTunnelStatus } from "./tunnelManager.js";
import { assertNotProductionWrite, getDataDir } from "./dataPaths.js";

export { getDataDir };

/** @deprecated Use getDataDir() — kept as alias for live path resolution. */
export function dataDir() {
  return getDataDir();
}

export function getConfigPath() {
  return path.join(getDataDir(), "config.json");
}

/** Live config path string (recomputed each access via function call sites). */
export function configPath() {
  return getConfigPath();
}

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
    server: {
      ...base.server,
      ...incoming?.server,
      tunnels: { ...base.server?.tunnels, ...incoming?.server?.tunnels }
    },
    providers: mergeProviders(base.providers, incoming?.providers),
    routing: {
      ...base.routing,
      ...incoming?.routing,
      taskRoutes: { ...base.routing.taskRoutes, ...incoming?.routing?.taskRoutes },
      namedRoutes: { ...base.routing?.namedRoutes, ...incoming?.routing?.namedRoutes },
      fallbackChain: incoming?.routing?.fallbackChain ?? base.routing.fallbackChain,
      taskPatterns: { ...base.routing?.taskPatterns, ...incoming?.routing?.taskPatterns }
    }
  };
}

function applyEnvOverrides(config) {
  if (process.env.ROUTERBOT_API_KEY) {
    config.server.apiKey = process.env.ROUTERBOT_API_KEY;
  }
  if (process.env.ROUTERBOT_HOST) {
    config.server.host = process.env.ROUTERBOT_HOST;
  }
  if (process.env.ROUTERBOT_PORT) {
    config.server.port = Number(process.env.ROUTERBOT_PORT);
  }
  if (process.env.NGROK_AUTHTOKEN && config.server.tunnels) {
    config.server.tunnels.ngrokAuthtoken = process.env.NGROK_AUTHTOKEN;
  }
  return config;
}

async function ensureApiKey(config, persist) {
  if (process.env.ROUTERBOT_API_KEY || config.server.apiKey) {
    return config;
  }
  const next = {
    ...config,
    server: { ...config.server, apiKey: generateApiKey() }
  };
  if (persist) {
    const dir = getDataDir();
    const cfgPath = getConfigPath();
    assertNotProductionWrite(cfgPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cfgPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log("Generated RouterBot API key (saved to data/config.json)");
    console.log(`  ${next.server.apiKey}`);
  }
  return next;
}

export async function syncCursorBaseUrl(config, { persist = false } = {}) {
  const port = config.server?.port ?? defaultConfig.server.port;
  const status = await getTunnelStatus(port);
  const persisted = reconcilePersistedCursorBaseUrl(config.server, status);
  const effective = effectiveCursorBaseUrl(
    { ...config.server, cursorBaseUrl: persisted },
    status
  );
  const current = (config.server.cursorBaseUrl || "").trim();
  let updated = config;
  if (persisted !== current) {
    updated = {
      ...config,
      server: { ...config.server, cursorBaseUrl: persisted }
    };
    if (persist) {
      const dir = getDataDir();
      const cfgPath = getConfigPath();
      assertNotProductionWrite(cfgPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(cfgPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    }
  }
  return {
    config: updated,
    status,
    effectiveCursorBaseUrl: effective,
    changed: persisted !== current
  };
}

export async function readConfig() {
  const cfgPath = getConfigPath();
  let config;
  try {
    const raw = await fs.readFile(cfgPath, "utf8");
    config = mergeConfig(defaultConfig, JSON.parse(raw));
    config = migrateGeminiToAntigravity(config);
    ({ config } = await syncCursorBaseUrl(config, { persist: true }));
    config = await ensureApiKey(config, false);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read config, using defaults: ${error.message}`);
    }
    config = mergeConfig(defaultConfig, {});
    config = migrateGeminiToAntigravity(config);
    ({ config } = await syncCursorBaseUrl(config, { persist: true }));
    config = await ensureApiKey(config, true);
  }
  return applyEnvOverrides(config);
}

export async function writeConfig(nextConfig) {
  let merged = migrateGeminiToAntigravity(mergeConfig(defaultConfig, nextConfig));
  ({ config: merged } = await syncCursorBaseUrl(merged, { persist: false }));
  const dir = getDataDir();
  const cfgPath = getConfigPath();
  assertNotProductionWrite(cfgPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(cfgPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return applyEnvOverrides(merged);
}

export { BUILTIN_PROVIDERS };
