import fs from "node:fs/promises";
import path from "node:path";
import { assertNotProductionWrite, getDataDir, PATHS } from "./dataPaths.js";

export { PATHS };

export const DEFAULT_MODEL_REFRESH = {
  enabled: true,
  schedule: "0 3 * * *",
  timezone: "America/New_York",
  requireProviderDiscovery: true,
  requirePricingRefresh: true,
  requireBenchmarkRefresh: true,
  requireHealthProbes: true,
  probePrimaryOnly: true,
  pricingCatalogMaxAgeHours: 24,
  maxSnapshotAgeHours: 36,
  maxRefreshSeconds: 300,
  staleSnapshotBehavior: "shadow_only",
  healthProbeExpansion: {
    enabled: true,
    topBlockedPerTask: 1,
    maxAdditionalProbes: 12,
    maxProbeSeconds: 300
  }
};

export function mergeModelRefreshConfig(smartRoute = {}) {
  return { ...DEFAULT_MODEL_REFRESH, ...(smartRoute.modelRefresh ?? {}) };
}

export function toCanonicalId(provider, model) {
  const modelId = model && String(model).trim() ? String(model).trim() : "default";
  return `${provider}:${modelId}`;
}

export function parseCanonicalId(canonicalId) {
  const idx = canonicalId.indexOf(":");
  if (idx <= 0) {
    return { provider: canonicalId, model: "default" };
  }
  return {
    provider: canonicalId.slice(0, idx),
    model: canonicalId.slice(idx + 1) || "default"
  };
}

export function emptySnapshot() {
  return {
    version: 1,
    generated_at: null,
    stale: true,
    refresh_status: "missing",
    models: [],
    rankings: {},
    changes: {
      new_models: [],
      removed_models: [],
      price_changes: [],
      benchmark_changes: [],
      health_changes: [],
      ranking_changes: []
    }
  };
}

export async function readCurrentSnapshot() {
  try {
    const raw = await fs.readFile(PATHS.current, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readSnapshotById(canonicalId) {
  const snapshot = await readCurrentSnapshot();
  if (!snapshot?.models?.length) {
    return null;
  }
  return snapshot.models.find((row) => row.canonical_id === canonicalId) ?? null;
}

export async function writeCurrentSnapshot(snapshot) {
  const dir = getDataDir();
  assertNotProductionWrite(PATHS.current);
  assertNotProductionWrite(PATHS.historyDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(PATHS.historyDir, { recursive: true });
  const payload = { ...snapshot, generated_at: snapshot.generated_at ?? new Date().toISOString() };
  await fs.writeFile(PATHS.current, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const day = payload.generated_at.slice(0, 10);
  await fs.writeFile(
    path.join(PATHS.historyDir, `${day}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
  return payload;
}

export async function appendRefreshLog(entry) {
  assertNotProductionWrite(PATHS.refreshLog);
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.appendFile(PATHS.refreshLog, `${JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() })}\n`, "utf8");
}

export async function readRefreshStatus() {
  const snapshot = await readCurrentSnapshot();
  const age = snapshotAgeHours(snapshot);
  const refresh = mergeModelRefreshConfig();
  return {
    snapshot_present: Boolean(snapshot),
    generated_at: snapshot?.generated_at ?? null,
    stale: isSnapshotStale(snapshot, refresh),
    age_hours: age,
    refresh_status: snapshot?.refresh_status ?? "missing",
    model_count: snapshot?.models?.length ?? 0,
    last_error: snapshot?.last_error ?? null,
    changes: snapshot?.changes ?? null
  };
}

export function snapshotAgeHours(snapshot) {
  if (!snapshot?.generated_at) {
    return null;
  }
  return (Date.now() - Date.parse(snapshot.generated_at)) / 3_600_000;
}

export const PASSIVE_SMART_ROUTE_MODES = new Set(["shadow_test", "manual"]);

export const ACTIVE_SMART_ROUTE_MODES = new Set([
  "balanced",
  "canary",
  "cost_saver",
  "maximum_quality",
  "local_private_first"
]);

export function isActiveSmartRouteMode(mode) {
  return ACTIVE_SMART_ROUTE_MODES.has(mode ?? "shadow_test");
}

export function isPassiveSmartRouteMode(mode) {
  const resolved = mode ?? "shadow_test";
  return PASSIVE_SMART_ROUTE_MODES.has(resolved) || !isActiveSmartRouteMode(resolved);
}

export function snapshotUsable(snapshot, config) {
  const refresh = mergeModelRefreshConfig(config?.routing?.smartRoute ?? {});
  return Boolean(
    snapshot?.models?.length &&
      snapshot.refresh_status === "ok" &&
      snapshot.stale !== true &&
      !isSnapshotStale(snapshot, refresh)
  );
}

export function isSnapshotStale(snapshot, refreshConfig = DEFAULT_MODEL_REFRESH) {
  if (!snapshot?.generated_at) {
    return true;
  }
  if (snapshot.stale === true) {
    return true;
  }
  const age = snapshotAgeHours(snapshot);
  return age == null || age > (refreshConfig.maxSnapshotAgeHours ?? 36);
}

export function canUseSnapshotForActiveMode(config, snapshot = null) {
  const mode = config?.routing?.smartRoute?.mode ?? "shadow_test";
  if (!isActiveSmartRouteMode(mode)) {
    return { allowed: true, reason: null };
  }
  if (!snapshotUsable(snapshot, config)) {
    return { allowed: false, reason: "model_intelligence_stale" };
  }
  return { allowed: true, reason: null };
}

/** Map intelligence snapshot → legacy registry entries for existing SmartRoute code. */
export function snapshotToRegistry(snapshot, config) {
  if (!snapshot?.models?.length) {
    return [];
  }

  return snapshot.models
    .filter((row) => row.available !== false && row.health_excluded !== true)
    .map((row) => {
      const pricing = row.pricing ?? {};
      const health = row.health ?? {};
      const caps = row.capabilities ?? {};
      return {
        id: row.canonical_id,
        provider: row.provider,
        model: row.model === "default" ? "" : row.model,
        enabled: row.available !== false,
        tier: row.tier ?? inferTier(row),
        local: row.local === true,
        cost_input_per_1m: pricing.input_per_1m ?? null,
        cost_output_per_1m: pricing.output_per_1m ?? null,
        cost_cached_input_per_1m: pricing.cached_input_per_1m ?? null,
        latency_class: row.latency_class ?? "medium",
        reliability: health.success_rate_24h ?? health.success_rate_7d ?? row.reliability ?? 0.75,
        capabilities: {
          chat: caps.chat !== false,
          reasoning: caps.reasoning ?? "medium",
          coding: caps.coding ?? "medium",
          vision: caps.vision === true,
          tool_calling: caps.tool_calling !== false,
          json_mode: caps.json_mode !== false,
          structured_output: caps.structured_output !== false,
          context_tokens: caps.context_tokens ?? 128000
        },
        limits: row.limits ?? {},
        routing: row.routing ?? { priority: 50, prefer_for: [], avoid_for: [], fallbacks: [] },
        intelligence: {
          pricing_confidence: pricing.pricing_confidence ?? 0,
          benchmark_confidence: row.benchmarks?.benchmark_confidence ?? 0,
          effective_cost_factor: row.effective_cost_factor ?? 1,
          health_excluded: row.health_excluded === true,
          pricing_unknown: pricing.pricing_source === "unknown"
        }
      };
    })
    .filter((entry) => {
      const providerConfig = config?.providers?.[entry.provider];
      return entry.enabled && providerConfig?.enabled !== false;
    });
}

function inferTier(row) {
  if (row.local) return "local";
  const input = row.pricing?.input_per_1m;
  if (input == null) return "mid";
  if (input <= 0.5) return "cheap";
  if (input <= 2) return "mid";
  return "premium";
}
