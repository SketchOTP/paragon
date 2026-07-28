import { createEventStore } from "./eventStore.js";
import { newSession } from "./schemas.js";

const PROVIDER_MODEL_KEY = (provider, model) => `${provider}:${model ?? "default"}`;

export function createSessionStore(dataDir) {
  const store = createEventStore({ name: "sessions", dataDir });

  async function getOrCreate(sessionId, { jobId, now = new Date().toISOString() } = {}) {
    const existing = store.get(sessionId);
    if (existing) {
      return existing;
    }
    const session = newSession({ sessionId, jobId, startTime: now });
    await store.append(session);
    return session;
  }

  /** Called once per request; folds run outcome + context estimate into running session totals. */
  async function recordActivity(sessionId, {
    now = new Date().toISOString(),
    isRootRun,
    inputTokens = 0,
    outputTokens = 0,
    contextTokens = 0,
    provider,
    model,
    activeDurationDeltaMs = 0
  }) {
    const session = store.get(sessionId);
    if (!session) {
      return null;
    }
    const key = PROVIDER_MODEL_KEY(provider, model);
    const updated = {
      ...session,
      latestActivityTime: now,
      activeDurationMs: session.activeDurationMs + activeDurationDeltaMs,
      requestCount: session.requestCount + 1,
      runCount: session.runCount + 1,
      rootRunCount: session.rootRunCount + (isRootRun ? 1 : 0),
      childRunCount: session.childRunCount + (isRootRun ? 0 : 1),
      maxObservedContextTokens: Math.max(session.maxObservedContextTokens, contextTokens),
      cumulativeInputTokensEstimate: session.cumulativeInputTokensEstimate + inputTokens,
      cumulativeOutputTokensEstimate: session.cumulativeOutputTokensEstimate + outputTokens,
      providerModelDistribution: {
        ...session.providerModelDistribution,
        [key]: (session.providerModelDistribution[key] ?? 0) + 1
      }
    };
    await store.append(updated);
    return updated;
  }

  function activeDurationMinutes(session, now = Date.now()) {
    const start = Date.parse(session.startTime);
    if (!Number.isFinite(start)) {
      return 0;
    }
    return Math.round((now - start) / 60000);
  }

  async function close(sessionId, now = new Date().toISOString()) {
    const session = store.get(sessionId);
    if (!session) {
      return null;
    }
    const updated = { ...session, endTime: now, status: "closed" };
    await store.append(updated);
    return updated;
  }

  return { ...store, getOrCreate, recordActivity, activeDurationMinutes, close };
}
