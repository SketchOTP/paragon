import path from "node:path";
import { createJobStore } from "./jobStore.js";
import { createSessionStore } from "./sessionStore.js";
import { createRunStore } from "./runStore.js";
import { createCheckpointStore } from "./checkpointStore.js";
import { createDecisionStore } from "./decisionStore.js";
import { extractCorrelation, correlationResponseHeaders } from "./correlation.js";
import { estimateRequestContext, estimateResponseSize } from "./contextEstimator.js";
import { evaluateShadowGovernor } from "./shadowGovernor.js";
import { objectiveHash } from "./duplication.js";
import { generateId } from "./ids.js";

/**
 * Owns all orchestration state stores and exposes the small set of
 * operations openaiApi.js / cli.js / httpProvider.js need. This is the
 * single integration seam between the existing request path and the new
 * `src/orchestration/` namespace — nothing here changes provider
 * selection, blocks requests, or mutates the prompt/response.
 */
export function createOrchestrationRuntime({ dataDir, getPolicy }) {
  const orchDataDir = path.join(dataDir, "orchestration");
  const jobs = createJobStore(orchDataDir);
  const sessions = createSessionStore(orchDataDir);
  const runs = createRunStore(orchDataDir);
  const checkpoints = createCheckpointStore(orchDataDir);
  const decisions = createDecisionStore(orchDataDir);

  async function beginRequest(headers, body) {
    const correlation = extractCorrelation(headers);
    const policy = getPolicy();
    const now = new Date().toISOString();

    await jobs.getOrCreate(correlation.jobId, { repository: correlation.repository, now });
    await jobs.attachSession(correlation.jobId, correlation.sessionId);
    const session = await sessions.getOrCreate(correlation.sessionId, { jobId: correlation.jobId, now });

    const contextEstimate = estimateRequestContext(body);
    const activeDurationMinutes = sessions.activeDurationMinutes(session, Date.parse(now));

    const isRoot = correlation.agentRole === "root" || !correlation.parentRunId;
    const siblings = isRoot ? [] : runs.openChildren(correlation.parentRunId);
    const totalChildRunsInJob = isRoot ? 0 : runs.byJob(correlation.jobId).filter((r) => r.parentRunId).length;
    const hasRecursiveChild = !isRoot && runs.get(correlation.parentRunId)?.parentRunId != null;

    const decisionInputs = evaluateShadowGovernor(policy, {
      estimatedInputTokens: contextEstimate.estimatedInputTokens,
      activeDurationMinutes,
      subagentCounts: isRoot
        ? null
        : { parallelChildRuns: siblings.length + 1, totalChildRunsInJob, hasRecursiveChild }
    });

    const savedDecisions =
      decisionInputs.length > 0
        ? await decisions.record({ jobId: correlation.jobId, sessionId: correlation.sessionId, runId: correlation.runId, now }, decisionInputs)
        : [];

    if (isRoot) {
      await jobs.attachRootRun(correlation.jobId, correlation.runId);
    }

    const run = await runs.start({
      runId: correlation.runId,
      parentRunId: correlation.parentRunId,
      jobId: correlation.jobId,
      sessionId: correlation.sessionId,
      agentRole: correlation.agentRole,
      provider: null,
      model: null,
      startTime: now,
      streaming: Boolean(body?.stream),
      repository: correlation.repository,
      objectiveHash: objectiveHash(correlation.taskType, body?.messages?.[0]?.content)
    });

    return {
      correlation,
      contextEstimate,
      run,
      decisions: savedDecisions,
      responseHeaders: {
        ...correlationResponseHeaders(correlation),
        "X-Paragon-Context-Estimate": String(contextEstimate.estimatedInputTokens),
        "X-Paragon-Governor-Warnings": String(savedDecisions.length)
      }
    };
  }

  async function recordRoute(runId, { provider, routeClassification, fallbackPosition = 0 }) {
    return runs.update(runId, { provider, routeClassification, fallbackPosition });
  }

  async function finishRequest(runId, {
    success,
    provider,
    model,
    fallbackPosition,
    errorClassification = null,
    timeout = false,
    cancelled = false,
    responseText = "",
    contextEstimate
  }) {
    const now = new Date().toISOString();
    const responseEstimate = estimateResponseSize(responseText);
    const finished = await runs.finish(runId, { now, success, errorClassification, timeout, cancelled, responseEstimate });
    if (!finished) return null;

    const withProvider =
      provider || model || fallbackPosition != null
        ? await runs.update(runId, {
            provider: provider ?? finished.provider,
            model: model ?? finished.model,
            fallbackPosition: fallbackPosition ?? finished.fallbackPosition
          })
        : finished;

    await jobs.recordUsage(withProvider.jobId, {
      inputTokens: contextEstimate?.estimatedInputTokens ?? 0,
      outputTokens: responseEstimate.estimatedOutputTokens,
      durationMs: withProvider.durationMs ?? 0
    });

    await sessions.recordActivity(withProvider.sessionId, {
      now,
      isRootRun: !withProvider.parentRunId,
      inputTokens: contextEstimate?.estimatedInputTokens ?? 0,
      outputTokens: responseEstimate.estimatedOutputTokens,
      contextTokens: contextEstimate?.estimatedInputTokens ?? 0,
      provider: withProvider.provider,
      model: withProvider.model,
      activeDurationDeltaMs: withProvider.durationMs ?? 0
    });

    return withProvider;
  }

  return {
    jobs,
    sessions,
    runs,
    checkpoints,
    decisions,
    beginRequest,
    recordRoute,
    finishRequest,
    newCheckpointId: () => generateId("checkpoint")
  };
}
