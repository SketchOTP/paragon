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

  // Note: the persisted field `activeDurationMs` accumulates actual provider
  // execution time (summed run durationMs, via recordActivity's
  // activeDurationDeltaMs) — it is NOT wall-clock time. The three duration
  // concepts below are kept explicitly distinct rather than conflated under
  // one ambiguous "duration" name (PARAGON-D-002A finding).

  /** Wall-clock time since the session started — what "session active for 8h" evidence means. */
  function wallClockDurationMinutes(session, now = Date.now()) {
    const start = Date.parse(session.startTime);
    if (!Number.isFinite(start)) {
      return 0;
    }
    const end = session.endTime ? Date.parse(session.endTime) : now;
    return Math.round((end - start) / 60000);
  }

  /** Sum of actual provider-execution durationMs across every run in this session. */
  function activeProviderDurationMinutes(session) {
    return Math.round(session.activeDurationMs / 60000);
  }

  /** Wall-clock time minus active provider-execution time — waiting/thinking/idle time. */
  function idleDurationMinutes(session, now = Date.now()) {
    return Math.max(0, wallClockDurationMinutes(session, now) - activeProviderDurationMinutes(session));
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

  return {
    ...store,
    getOrCreate,
    recordActivity,
    wallClockDurationMinutes,
    activeProviderDurationMinutes,
    idleDurationMinutes,
    close
  };
}
