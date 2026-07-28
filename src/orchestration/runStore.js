import { createEventStore } from "./eventStore.js";
import { newRun } from "./schemas.js";

export function createRunStore(dataDir) {
  const store = createEventStore({ name: "runs", dataDir });

  async function start(params) {
    const run = newRun(params);
    await store.append(run);
    return run;
  }

  async function update(runId, patch) {
    const run = store.get(runId);
    if (!run) {
      return null;
    }
    const updated = { ...run, ...patch };
    await store.append(updated);
    return updated;
  }

  async function finish(runId, {
    now = new Date().toISOString(),
    success,
    errorClassification = null,
    timeout = false,
    cancelled = false,
    responseEstimate = null
  }) {
    const run = store.get(runId);
    if (!run) {
      return null;
    }
    const startMs = Date.parse(run.startTime);
    const endMs = Date.parse(now);
    const updated = {
      ...run,
      endTime: now,
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null,
      success,
      errorClassification,
      timeout,
      cancelled,
      responseEstimate
    };
    await store.append(updated);
    return updated;
  }

  /** Child runs currently open (no endTime) whose parentRunId is the given run — used for parallel-child accounting. */
  function openChildren(parentRunId) {
    return store.all().filter((r) => r.parentRunId === parentRunId && !r.endTime);
  }

  function childrenOf(parentRunId) {
    return store.all().filter((r) => r.parentRunId === parentRunId);
  }

  function rootRunsOf(sessionId) {
    return store.all().filter((r) => r.sessionId === sessionId && !r.parentRunId);
  }

  function byJob(jobId) {
    return store.all().filter((r) => r.jobId === jobId);
  }

  return { ...store, start, update, finish, openChildren, childrenOf, rootRunsOf, byJob };
}
