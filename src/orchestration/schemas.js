export const SCHEMA_VERSION = 1;

export const AGENT_ROLES = [
  "root",
  "planner",
  "explorer",
  "implementer",
  "tester",
  "reviewer",
  "researcher",
  "general-purpose",
  "unknown"
];

export function newJob({ jobId, repository, objective, createdAt }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: jobId,
    repository: repository ?? null,
    objective: objective ?? null,
    createdAt,
    completedAt: null,
    status: "active",
    sessionIds: [],
    rootRunIds: [],
    aggregateUsage: { inputTokensEstimate: 0, outputTokensEstimate: 0, runCount: 0 },
    aggregateDurationMs: 0
  };
}

export function newSession({ sessionId, jobId, startTime }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: sessionId,
    jobId,
    startTime,
    latestActivityTime: startTime,
    endTime: null,
    activeDurationMs: 0,
    requestCount: 0,
    runCount: 0,
    rootRunCount: 0,
    childRunCount: 0,
    maxObservedContextTokens: 0,
    cumulativeInputTokensEstimate: 0,
    cumulativeOutputTokensEstimate: 0,
    providerModelDistribution: {},
    status: "active"
  };
}

export function newRun({
  runId,
  parentRunId,
  jobId,
  sessionId,
  agentRole,
  provider,
  model,
  routeClassification,
  fallbackPosition,
  startTime,
  streaming,
  repository,
  objectiveHash
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: runId,
    parentRunId: parentRunId ?? null,
    jobId,
    sessionId,
    agentRole: AGENT_ROLES.includes(agentRole) ? agentRole : "unknown",
    provider,
    model: model ?? null,
    routeClassification: routeClassification ?? null,
    fallbackPosition: fallbackPosition ?? 0,
    repository: repository ?? null,
    objectiveHash: objectiveHash ?? null,
    startTime,
    endTime: null,
    durationMs: null,
    requestContextEstimate: null,
    responseEstimate: null,
    toolSchemaEstimate: 0,
    streaming: Boolean(streaming),
    success: null,
    errorClassification: null,
    timeout: false,
    cancelled: false,
    retryOf: null
  };
}

/**
 * One provider/model execution within a run's fallback sequence.
 * RUN = one incoming PARAGON request. ATTEMPT = one provider try within it.
 */
export function newAttempt({
  attemptId,
  runId,
  provider,
  model,
  fallbackPosition,
  startTime,
  processId
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: attemptId,
    runId,
    provider,
    model: model ?? null,
    fallbackPosition: fallbackPosition ?? 0,
    startTime,
    endTime: null,
    durationMs: null,
    success: null,
    timeout: false,
    cancelled: false,
    errorClassification: null,
    errorDiagnostic: null,
    fallbackReason: null,
    followedByAnotherAttempt: null,
    processId: processId ?? null
  };
}

export function newCheckpoint({
  checkpointId,
  jobId,
  sessionId,
  runId,
  timestamp,
  activeObjective,
  completedWorkSummary,
  remainingWorkSummary,
  repository,
  validationState,
  unresolvedFailures,
  relevantFiles,
  source
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: checkpointId,
    jobId,
    sessionId,
    runId: runId ?? null,
    timestamp,
    activeObjective: activeObjective ?? null,
    completedWorkSummary: completedWorkSummary ?? null,
    remainingWorkSummary: remainingWorkSummary ?? null,
    repository: repository ?? null,
    validationState: validationState ?? null,
    unresolvedFailures: unresolvedFailures ?? [],
    relevantFiles: relevantFiles ?? [],
    source: source ?? "manual",
    completeness: activeObjective && completedWorkSummary ? "complete" : "partial"
  };
}

export function newDecision({
  decisionId,
  jobId,
  sessionId,
  runId,
  timestamp,
  policyRule,
  observedValue,
  threshold,
  proposedAction,
  explanation,
  confidence,
  missingEvidence
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: decisionId,
    jobId,
    sessionId,
    runId: runId ?? null,
    timestamp,
    policyRule,
    observedValue,
    threshold,
    proposedAction,
    enforcementMode: "shadow",
    explanation,
    confidence: confidence ?? "medium",
    missingEvidence: missingEvidence ?? []
  };
}
