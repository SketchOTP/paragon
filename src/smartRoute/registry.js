import fs from "node:fs/promises";
import {
  readCurrentSnapshot,
  snapshotToRegistry,
  snapshotUsable,
} from "./modelSnapshotStore.js";
import { pickBestModelForTask } from "./modelRanker.js";
import { PATHS } from "./dataPaths.js";

function getDefaultRegistryPath() {
  return PATHS.modelsRegistry;
}

let cachedRegistry = null;
let cachedSnapshotAt = null;
let cachedAt = 0;
const CACHE_MS = 5000;

export async function loadModelRegistry(config, { force = false } = {}) {
  const snapshot = await readCurrentSnapshot();
  const snapshotOk = snapshotUsable(snapshot, config);

  if (snapshotOk) {
    const snapAt = snapshot.generated_at ?? "";
    const now = Date.now();
    if (!force && cachedRegistry && cachedSnapshotAt === snapAt && now - cachedAt < CACHE_MS) {
      return filterRegistry(cachedRegistry, config);
    }
    cachedRegistry = snapshotToRegistry(snapshot, config);
    cachedSnapshotAt = snapAt;
    cachedAt = now;
    if (cachedRegistry.length) {
      return filterRegistry(cachedRegistry, config);
    }
  }

  return loadLegacyRegistry(config, { force });
}

async function loadLegacyRegistry(config, { force = false } = {}) {
  const now = Date.now();
  if (!force && cachedRegistry && !cachedSnapshotAt && now - cachedAt < CACHE_MS) {
    return filterRegistry(cachedRegistry, config);
  }

  let raw;
  try {
    raw = await fs.readFile(getDefaultRegistryPath(), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    cachedRegistry = [];
    cachedAt = now;
    cachedSnapshotAt = null;
    return [];
  }

  const parsed = JSON.parse(raw);
  cachedRegistry = Array.isArray(parsed) ? parsed : [];
  cachedAt = now;
  cachedSnapshotAt = null;
  return filterRegistry(cachedRegistry, config);
}

export async function resolveIntelligentSelection(taskType, config, options = {}) {
  const snapshot = await readCurrentSnapshot();
  if (!snapshot?.models?.length) {
    return { model: null, reason: "model_intelligence_stale" };
  }
  const best = pickBestModelForTask(snapshot.models, taskType, options);
  if (!best) {
    return { model: null, reason: "no_model_passed_quality_floor" };
  }
  const registry = snapshotToRegistry(snapshot, config);
  const entry = registry.find((row) => row.id === best.canonical_id);
  return { model: entry ?? null, snapshot, reason: null, canonical_id: best.canonical_id };
}

function filterRegistry(registry, config) {
  return registry.filter((entry) => isEnabledInConfig(entry, config));
}

function isEnabledInConfig(entry, config) {
  const providerConfig = config?.providers?.[entry.provider];
  if (!providerConfig) {
    return entry.enabled !== false;
  }
  return entry.enabled !== false && providerConfig.enabled !== false;
}

export function getRegistryEntry(registry, id) {
  return registry.find((entry) => entry.id === id) ?? null;
}

export function registryPath() {
  return getDefaultRegistryPath();
}

export function invalidateRegistryCache() {
  cachedRegistry = null;
  cachedAt = 0;
  cachedSnapshotAt = null;
}

export function cheapestCapable(registry, capability) {
  const capable = registry.filter((entry) => entry.capabilities?.[capability]);
  if (!capable.length) {
    return null;
  }
  return capable.sort(compareByCost)[0];
}

export function cheapestModelWithContext(registry, tokens) {
  const capable = registry.filter((entry) => (entry.capabilities?.context_tokens ?? 0) >= tokens);
  if (!capable.length) {
    return null;
  }
  return capable.sort(compareByCost)[0];
}

export function cheapestLocalCapable(registry) {
  const local = registry.filter((entry) => entry.local);
  if (!local.length) {
    return null;
  }
  return local.sort(compareByCost)[0];
}

function compareByCost(a, b) {
  const costA = (a.cost_input_per_1m ?? 0) + (a.cost_output_per_1m ?? 0);
  const costB = (b.cost_input_per_1m ?? 0) + (b.cost_output_per_1m ?? 0);
  if (costA !== costB) {
    return costA - costB;
  }
  return (a.routing?.priority ?? 50) - (b.routing?.priority ?? 50);
}

export function estimateCost(entry, inputTokens, outputTokens) {
  const inCost = ((inputTokens ?? 0) / 1_000_000) * (entry.cost_input_per_1m ?? 0);
  const outCost = ((outputTokens ?? 0) / 1_000_000) * (entry.cost_output_per_1m ?? 0);
  return inCost + outCost;
}
