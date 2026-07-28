import path from "node:path";
import { createJobStore } from "./jobStore.js";
import { createSessionStore } from "./sessionStore.js";
import { createRunStore } from "./runStore.js";
import { createAttemptStore } from "./attemptStore.js";
import { createCheckpointStore } from "./checkpointStore.js";
import { createDecisionStore } from "./decisionStore.js";
import { extractCorrelation, correlationResponseHeaders } from "./correlation.js";
import { estimateRequestContext, estimateResponseSize } from "./contextEstimator.js";
import { evaluateShadowGovernor } from "./shadowGovernor.js";
import { objectiveHash } from "./duplication.js";
import { generateId, isValidId } from "./ids.js";

function finalUserMessageContent(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") {
      return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    }
  }
  return null;
}

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
  const attempts = createAttemptStore(orchDataDir);
  const checkpoints = createCheckpointStore(orchDataDir);
  const decisions = createDecisionStore(orchDataDir);

  async function beginRequest(headers, body) {
    const correlation = extractCorrelation(headers);
    const policy = getPolicy();
    const now = new Date().toISOString();

    // A client-supplied run id that collides with an existing, unrelated
    // run must never silently overwrite that record (PARAGON-D-002A).
    // Session/job ids are *meant* to be reused across requests — this
    // guard only applies to run ids, which are meant to be unique per
    // request.
    let runId = correlation.runId;
    if (isValidId(runId) && runs.get(runId)) {
      runId = generateId("run");
    }
    correlation.runId = runId;

    await jobs.getOrCreate(correlation.jobId, { repository: correlation.repository, now });
    await jobs.attachSession(correlation.jobId, correlation.sessionId);
    const session = await sessions.getOrCreate(correlation.sessionId, { jobId: correlation.jobId, now });

    const contextEstimate = estimateRequestContext(body);
    const wallClockDurationMinutes = sessions.wallClockDurationMinutes(session, Date.parse(now));

    const isRoot = correlation.agentRole === "root" || !correlation.parentRunId;
    const siblings = isRoot ? [] : runs.openChildren(correlation.parentRunId);
    // +1 includes the run currently being created — omitting it undercounts
    // by one and lets the Nth child through the (N > limit) check unflagged
    // (PARAGON-D-002A finding).
    const totalChildRunsInJob = isRoot ? 0 : runs.byJob(correlation.jobId).filter((r) => r.parentRunId).length + 1;
    const hasRecursiveChild = !isRoot && runs.get(correlation.parentRunId)?.parentRunId != null;

    const decisionInputs = evaluateShadowGovernor(policy, {
      estimatedInputTokens: contextEstimate.estimatedInputTokens,
      activeDurationMinutes: wallClockDurationMinutes,
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

    // Objective hash deliberately never uses messages[0] — that is very
    // commonly a shared system prompt, and hashing it would make every
    // sibling child run in a session look like a duplicate of every other
    // (PARAGON-D-002A finding). It requires an explicit task-type header
    // AND a final user-authored message; either missing means "no reliable
    // objective hash" (null), not a guess.
    const objHash = objectiveHash(correlation.taskType, finalUserMessageContent(body?.messages));

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
      objectiveHash: objHash
    });

    return {
      correlation,
      contextEstimate,
      run,
      decisions: savedDecisions,
      responseHeaders: {
        ...correlationResponseHeaders(correlation, policy.mode),
        "X-Paragon-Context-Estimate": String(contextEstimate.estimatedInputTokens),
        "X-Paragon-Governor-Warnings": String(savedDecisions.length)
      }
    };
  }

  async function recordRoute(runId, { provider, routeClassification, fallbackPosition = 0 }) {
    return runs.update(runId, { provider, routeClassification, fallbackPosition });
  }

  // --- Per-attempt telemetry: one HTTP request (run) can try several
  // providers via the fallback chain. Each try is its own attempt record.

  async function beginAttempt(runId, { provider, model, fallbackPosition }) {
    return attempts.start({
      attemptId: generateId("attempt"),
      runId,
      provider,
      model,
      fallbackPosition,
      startTime: new Date().toISOString()
    });
  }

  async function finishAttempt(attemptId, params) {
    return attempts.finish(attemptId, { now: new Date().toISOString(), ...params });
  }

  async function recordAttemptProcessId(attemptId, processId) {
    if (processId == null) {
      return null;
    }
    return attempts.append?.({ ...attempts.get(attemptId), processId });
  }

  async function finishRequest(telemetryResult, {
    success,
    provider,
    model,
    fallbackPosition,
    errorClassification = null,
    errorDiagnostic = null,
    timeout = false,
    cancelled = false,
    responseText,
    responseEstimate: suppliedResponseEstimate
  }) {
    const { run, correlation, contextEstimate } = telemetryResult;
    const runId = run.id;
    const now = new Date().toISOString();
    const responseEstimate = suppliedResponseEstimate ?? estimateResponseSize(responseText ?? "");
    const finished = await runs.finish(runId, {
      now,
      success,
      errorClassification,
      timeout,
      cancelled,
      responseEstimate
    });
    if (!finished) return null;

    const withProvider =
      provider || model || fallbackPosition != null
        ? await runs.update(runId, {
            provider: provider ?? finished.provider,
            model: model ?? finished.model,
            fallbackPosition: fallbackPosition ?? finished.fallbackPosition,
            errorDiagnostic
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

    // An untagged request's one-request implicit session/job must not stay
    // "active" forever — otherwise ordinary untagged traffic silently
    // inflates active-session/active-job counts without bound
    // (PARAGON-D-002A finding). Explicit caller-supplied sessions are left
    // open; only sessions PARAGON itself invented get auto-closed.
    if (correlation?.sessionIsImplicit) {
      await sessions.close(withProvider.sessionId, now);
      const job = jobs.get(withProvider.jobId);
      const stillHasActiveSessions = (job?.sessionIds ?? []).some((id) => sessions.get(id)?.status === "active");
      if (job && !stillHasActiveSessions) {
        await jobs.close(withProvider.jobId, now);
      }
    }

    return withProvider;
  }

  return {
    jobs,
    sessions,
    runs,
    attempts,
    checkpoints,
    decisions,
    beginRequest,
    recordRoute,
    beginAttempt,
    finishAttempt,
    recordAttemptProcessId,
    finishRequest,
    newCheckpointId: () => generateId("checkpoint")
  };
}
