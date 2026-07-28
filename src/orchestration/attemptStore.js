import { createEventStore } from "./eventStore.js";
import { newAttempt } from "./schemas.js";

export function createAttemptStore(dataDir) {
  const store = createEventStore({ name: "attempts", dataDir });

  async function start(params) {
    const attempt = newAttempt(params);
    await store.append(attempt);
    return attempt;
  }

  async function finish(attemptId, {
    now = new Date().toISOString(),
    success,
    timeout = false,
    cancelled = false,
    errorClassification = null,
    errorDiagnostic = null,
    fallbackReason = null,
    followedByAnotherAttempt = false
  }) {
    const attempt = store.get(attemptId);
    if (!attempt) {
      return null;
    }
    const startMs = Date.parse(attempt.startTime);
    const endMs = Date.parse(now);
    const updated = {
      ...attempt,
      endTime: now,
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null,
      success,
      timeout,
      cancelled,
      errorClassification,
      errorDiagnostic,
      fallbackReason,
      followedByAnotherAttempt
    };
    await store.append(updated);
    return updated;
  }

  function byRun(runId) {
    return store.all().filter((a) => a.runId === runId);
  }

  return { ...store, start, finish, byRun };
}
