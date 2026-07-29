/**
 * Automatic 24h model-catalog refresh scheduler (PARAGON-D-004C).
 *
 * Fully internal — no systemd timer or operator cron job required. Resumes
 * correctly across a service restart because "when to refresh next" is
 * read from the persisted catalog (schedule.nextRefreshAt), not from
 * in-memory state that a restart would lose.
 */

import { loadCatalog } from "./modelCatalog.js";
import { runFullRefresh } from "./modelCatalogRefresh.js";
import { addLog } from "./logStore.js";

function msUntil(isoTimestamp) {
  if (!isoTimestamp) {
    return 0;
  }
  return Math.max(0, Date.parse(isoTimestamp) - Date.now());
}

/**
 * @param {() => Promise<object>} getConfig
 * @param {object} [options]
 * @param {(result: object) => void} [options.onRefreshComplete]
 * @param {() => Promise<object>} [options.loadCatalogFn] - injectable for tests; defaults to the real persisted store
 * @param {(config: object, opts: object) => Promise<object>} [options.runFullRefreshFn] - injectable for tests
 * @returns {{ stop: () => void, triggerNow: () => Promise<object> }}
 */
export function startModelCatalogScheduler(getConfig, options = {}) {
  const { onRefreshComplete, loadCatalogFn = loadCatalog, runFullRefreshFn = runFullRefresh } = options;
  // Scoped per scheduler instance — a module-level timer would let two
  // instances (e.g. tests creating more than one) clobber each other's
  // handle via stop().
  let timer = null;

  async function tick() {
    const config = await getConfig();
    const settings = config.modelCatalog ?? {};
    if (settings.enabled === false) {
      // Still re-check periodically in case the operator re-enables it —
      // 1h is a harmless idle poll interval, not a refresh.
      timer = setTimeout(tick, 3_600_000);
      return;
    }

    const result = await runFullRefreshFn(config, {
      refreshIntervalHours: settings.refreshIntervalHours ?? 24,
      maxConcurrentProviderRefreshes: settings.maxConcurrentProviderRefreshes ?? 1,
      maxValidationProbesPerProvider: settings.maxValidationProbesPerProvider ?? 10
    });

    if (!result.skipped) {
      addLog({
        type: "models",
        provider: "paragon",
        level: "info",
        message: `Model catalog refresh complete. Next refresh: ${result.catalog.schedule.nextRefreshAt}`
      });
      onRefreshComplete?.(result);
    }

    const catalog = result.catalog ?? (await loadCatalogFn());
    const delay = msUntil(catalog.schedule.nextRefreshAt) || (settings.refreshIntervalHours ?? 24) * 3_600_000;
    timer = setTimeout(tick, delay);
  }

  async function start() {
    const config = await getConfig();
    const settings = config.modelCatalog ?? {};
    if (settings.enabled === false) {
      timer = setTimeout(tick, 3_600_000);
      return;
    }

    const catalog = await loadCatalogFn();
    const staleAfterMs = (settings.refreshIntervalHours ?? 24) * 3_600_000;
    const neverRefreshed = !catalog.schedule.lastSuccessfulRefreshAt;
    const stale = neverRefreshed || Date.now() - Date.parse(catalog.schedule.lastSuccessfulRefreshAt) > staleAfterMs;

    if (neverRefreshed || (stale && settings.refreshOnStartupIfStale !== false)) {
      // Fire immediately (async — must not block server startup) rather
      // than waiting out whatever's left of a schedule that's already
      // expired.
      tick();
      return;
    }

    const delay = msUntil(catalog.schedule.nextRefreshAt) || staleAfterMs;
    timer = setTimeout(tick, delay);
  }

  const startPromise = start();

  return {
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    /** Exposed for tests that need to await the initial start() before asserting. */
    ready: startPromise,
    async triggerNow() {
      const config = await getConfig();
      const settings = config.modelCatalog ?? {};
      if (timer) {
        clearTimeout(timer);
      }
      const result = await runFullRefreshFn(config, {
        refreshIntervalHours: settings.refreshIntervalHours ?? 24,
        maxConcurrentProviderRefreshes: settings.maxConcurrentProviderRefreshes ?? 1,
        maxValidationProbesPerProvider: settings.maxValidationProbesPerProvider ?? 10
      });
      if (!result.skipped) {
        onRefreshComplete?.(result);
      }
      const catalog = result.catalog ?? (await loadCatalogFn());
      const delay = msUntil(catalog.schedule.nextRefreshAt) || (settings.refreshIntervalHours ?? 24) * 3_600_000;
      timer = setTimeout(tick, delay);
      return result;
    }
  };
}
