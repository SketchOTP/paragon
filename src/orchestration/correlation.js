import { acceptOrGenerateId, isValidId } from "./ids.js";
import { AGENT_ROLES } from "./schemas.js";

export const CORRELATION_HEADERS = {
  jobId: "x-paragon-job-id",
  sessionId: "x-paragon-session-id",
  runId: "x-paragon-run-id",
  parentRunId: "x-paragon-parent-run-id",
  agentRole: "x-paragon-agent-role",
  repository: "x-paragon-repository",
  taskType: "x-paragon-task-type"
};

const REPO_TASK_PATTERN = /^[\w.\-/: ]{1,200}$/;

function sanitizeFreeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !REPO_TASK_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Reads optional correlation headers off an incoming request. Missing
 * job/run ids are generated; missing session identity is never guessed
 * from IP — an untagged request becomes its own one-request session.
 * Malformed supplied ids are safely discarded (treated as absent), not
 * rejected with an error, so existing clients that send garbage never break.
 */
export function extractCorrelation(headers = {}) {
  const get = (name) => headers[name] ?? headers[name.toLowerCase()];

  const suppliedJobId = get(CORRELATION_HEADERS.jobId);
  const suppliedSessionId = get(CORRELATION_HEADERS.sessionId);
  const suppliedRunId = get(CORRELATION_HEADERS.runId);
  const suppliedParentRunId = get(CORRELATION_HEADERS.parentRunId);
  const suppliedRole = get(CORRELATION_HEADERS.agentRole);

  const jobId = acceptOrGenerateId("job", suppliedJobId);
  const runId = acceptOrGenerateId("run", suppliedRunId);
  const parentRunId = isValidId(suppliedParentRunId) ? suppliedParentRunId : null;

  // No session header and no valid id: this request is its own one-request session.
  const sessionId = isValidId(suppliedSessionId) ? suppliedSessionId : acceptOrGenerateId("session", null);
  const sessionIsImplicit = !isValidId(suppliedSessionId);

  const agentRole = AGENT_ROLES.includes(suppliedRole) ? suppliedRole : "unknown";

  return {
    jobId,
    sessionId,
    sessionIsImplicit,
    runId,
    parentRunId,
    agentRole,
    repository: sanitizeFreeText(get(CORRELATION_HEADERS.repository)),
    taskType: sanitizeFreeText(get(CORRELATION_HEADERS.taskType))
  };
}

/**
 * `mode` must be the orchestration policy's actual configured mode
 * ("off" or "shadow") — never hardcoded. A response header claiming
 * "shadow" while the operator has configured "off" would misrepresent
 * what PARAGON is actually doing (PARAGON-D-002A finding).
 */
export function correlationResponseHeaders(correlation, mode) {
  return {
    "X-Paragon-Job-ID": correlation.jobId,
    "X-Paragon-Session-ID": correlation.sessionId,
    "X-Paragon-Run-ID": correlation.runId,
    "X-Paragon-Enforcement-Mode": mode ?? "off"
  };
}
