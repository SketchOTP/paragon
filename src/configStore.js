import fs from "node:fs/promises";
import path from "node:path";
import { generateApiKey } from "./auth.js";
import { migrateToParagon, migrateOrchestrationMode } from "./configMigrate.js";
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
    routing: {
      ...base.routing,
      ...incoming?.routing,
      taskRoutes: { ...base.routing.taskRoutes, ...incoming?.routing?.taskRoutes },
      fallbackChain: incoming?.routing?.fallbackChain ?? base.routing.fallbackChain
    },
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

export async function readConfig() {
  let config;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    config = mergeConfig(defaultConfig, JSON.parse(raw));
    config = migrateToParagon(migrateOrchestrationMode(config));
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
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return applyEnvOverrides(merged);
}

export { BUILTIN_PROVIDERS, configPath, dataDir };
