import assert from "node:assert/strict";
import test from "node:test";
import { startModelCatalogScheduler } from "../src/modelCatalogScheduler.js";

function fakeConfig(overrides = {}) {
  return { modelCatalog: { enabled: true, refreshIntervalHours: 24, refreshOnStartupIfStale: true, ...overrides } };
}

function fakeCatalog(overrides = {}) {
  return {
    generation: 0,
    schedule: { refreshing: false, lastRefreshStartedAt: null, lastRefreshCompletedAt: null, lastSuccessfulRefreshAt: null, nextRefreshAt: null, ...overrides },
    providers: {}
  };
}

test("startModelCatalogScheduler refreshes immediately on startup when the catalog has never been refreshed", async () => {
  let refreshCalls = 0;
  const scheduler = startModelCatalogScheduler(async () => fakeConfig(), {
    loadCatalogFn: async () => fakeCatalog(),
    runFullRefreshFn: async () => {
      refreshCalls += 1;
      return { skipped: false, outcomes: {}, catalog: fakeCatalog({ lastSuccessfulRefreshAt: new Date().toISOString(), nextRefreshAt: new Date(Date.now() + 24 * 3_600_000).toISOString() }) };
    }
  });
  await scheduler.ready;
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshCalls, 1);
  scheduler.stop();
});

test("startModelCatalogScheduler does not refresh on startup when the persisted schedule is still fresh — it resumes from the persisted nextRefreshAt instead", async () => {
  let refreshCalls = 0;
  const nextRefreshAt = new Date(Date.now() + 12 * 3_600_000).toISOString();
  const scheduler = startModelCatalogScheduler(async () => fakeConfig(), {
    loadCatalogFn: async () =>
      fakeCatalog({
        lastSuccessfulRefreshAt: new Date(Date.now() - 1 * 3_600_000).toISOString(),
        nextRefreshAt
      }),
    runFullRefreshFn: async () => {
      refreshCalls += 1;
      return { skipped: false, outcomes: {}, catalog: fakeCatalog() };
    }
  });
  await scheduler.ready;
  assert.equal(refreshCalls, 0, "a fresh, not-yet-due schedule must resume waiting, not refresh again immediately");
  scheduler.stop();
});

test("startModelCatalogScheduler refreshes on startup when the persisted schedule is stale (past 24h)", async () => {
  let refreshCalls = 0;
  const scheduler = startModelCatalogScheduler(async () => fakeConfig(), {
    loadCatalogFn: async () =>
      fakeCatalog({
        lastSuccessfulRefreshAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
        nextRefreshAt: new Date(Date.now() - 6 * 3_600_000).toISOString()
      }),
    runFullRefreshFn: async () => {
      refreshCalls += 1;
      return { skipped: false, outcomes: {}, catalog: fakeCatalog() };
    }
  });
  await scheduler.ready;
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshCalls, 1);
  scheduler.stop();
});

test("startModelCatalogScheduler does nothing but poll hourly when modelCatalog.enabled is false", async () => {
  let refreshCalls = 0;
  const scheduler = startModelCatalogScheduler(async () => fakeConfig({ enabled: false }), {
    loadCatalogFn: async () => fakeCatalog(),
    runFullRefreshFn: async () => {
      refreshCalls += 1;
      return { skipped: false, outcomes: {}, catalog: fakeCatalog() };
    }
  });
  await scheduler.ready;
  assert.equal(refreshCalls, 0);
  scheduler.stop();
});

test("triggerNow runs a refresh immediately regardless of the persisted schedule and calls onRefreshComplete", async () => {
  let completedWith = null;
  const scheduler = startModelCatalogScheduler(async () => fakeConfig(), {
    loadCatalogFn: async () => fakeCatalog({ lastSuccessfulRefreshAt: new Date().toISOString(), nextRefreshAt: new Date(Date.now() + 24 * 3_600_000).toISOString() }),
    runFullRefreshFn: async () => ({ skipped: false, outcomes: { claude: { ok: true } }, catalog: fakeCatalog({ nextRefreshAt: new Date(Date.now() + 24 * 3_600_000).toISOString() }) }),
    onRefreshComplete: (result) => {
      completedWith = result;
    }
  });
  await scheduler.ready;
  const result = await scheduler.triggerNow();
  assert.equal(result.skipped, false);
  assert.deepEqual(completedWith.outcomes, { claude: { ok: true } });
  scheduler.stop();
});

test("two scheduler instances have independent timers — stopping one must not affect the other", async () => {
  const a = startModelCatalogScheduler(async () => fakeConfig(), {
    loadCatalogFn: async () => fakeCatalog({ lastSuccessfulRefreshAt: new Date().toISOString(), nextRefreshAt: new Date(Date.now() + 24 * 3_600_000).toISOString() }),
    runFullRefreshFn: async () => ({ skipped: false, outcomes: {}, catalog: fakeCatalog() })
  });
  let bTicked = false;
  const b = startModelCatalogScheduler(async () => fakeConfig(), {
    loadCatalogFn: async () => fakeCatalog(),
    runFullRefreshFn: async () => {
      bTicked = true;
      return { skipped: false, outcomes: {}, catalog: fakeCatalog({ nextRefreshAt: new Date(Date.now() + 24 * 3_600_000).toISOString() }) };
    }
  });
  await a.ready;
  a.stop();
  await b.ready;
  await new Promise((r) => setImmediate(r));
  assert.equal(bTicked, true, "instance b's own refresh must still have run even though a.stop() was called first");
  b.stop();
});
