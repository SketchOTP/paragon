import { createEventStore } from "./eventStore.js";
import { newJob } from "./schemas.js";

export function createJobStore(dataDir) {
  const store = createEventStore({ name: "jobs", dataDir });

  async function getOrCreate(jobId, { repository, objective, now = new Date().toISOString() } = {}) {
    const existing = store.get(jobId);
    if (existing) {
      return existing;
    }
    const job = newJob({ jobId, repository, objective, createdAt: now });
    await store.append(job);
    return job;
  }

  async function attachSession(jobId, sessionId) {
    const job = store.get(jobId);
    if (!job || job.sessionIds.includes(sessionId)) {
      return job;
    }
    const updated = { ...job, sessionIds: [...job.sessionIds, sessionId] };
    await store.append(updated);
    return updated;
  }

  async function attachRootRun(jobId, runId) {
    const job = store.get(jobId);
    if (!job || job.rootRunIds.includes(runId)) {
      return job;
    }
    const updated = { ...job, rootRunIds: [...job.rootRunIds, runId] };
    await store.append(updated);
    return updated;
  }

  async function recordUsage(jobId, { inputTokens = 0, outputTokens = 0, durationMs = 0 } = {}) {
    const job = store.get(jobId);
    if (!job) {
      return null;
    }
    const updated = {
      ...job,
      aggregateUsage: {
        inputTokensEstimate: job.aggregateUsage.inputTokensEstimate + inputTokens,
        outputTokensEstimate: job.aggregateUsage.outputTokensEstimate + outputTokens,
        runCount: job.aggregateUsage.runCount + 1
      },
      aggregateDurationMs: job.aggregateDurationMs + durationMs
    };
    await store.append(updated);
    return updated;
  }

  return { ...store, getOrCreate, attachSession, attachRootRun, recordUsage };
}
