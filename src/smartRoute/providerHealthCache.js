import { checkProviderHealth } from "./providerCheck.js";

export const cache = { at: 0, map: null };

export function clearProviderHealthCache() {
  cache.at = 0;
  cache.map = null;
}

export async function getLiveProviderHealth(config, { maxAgeMs = 120_000, providers = null } = {}) {
  if (cache.map && Date.now() - cache.at < maxAgeMs) {
    return cache.map;
  }

  const result = await checkProviderHealth(config, providers ?? undefined);
  const map = {};
  for (const row of result.providers) {
    map[row.provider] = {
      healthy: row.reachable === true && row.response_ok === true,
      response_ok: row.response_ok,
      reachable: row.reachable,
      error: row.error,
      failure_category: row.failure_category ?? null,
      latency_ms: row.latency_ms
    };
  }

  cache.at = Date.now();
  cache.map = map;
  return map;
}

export function isProviderHealthy(healthMap, providerName) {
  return healthMap?.[providerName]?.healthy === true;
}
