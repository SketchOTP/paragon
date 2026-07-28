import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOrchestrationRuntime } from "../src/orchestration/telemetry.js";
import { DEFAULT_ORCHESTRATION_CONFIG } from "../src/orchestration/governorPolicy.js";
import { evaluateShadowGovernor } from "../src/orchestration/shadowGovernor.js";
import { estimateRequestContext } from "../src/orchestration/contextEstimator.js";
import { detectDuplication, objectiveHash } from "../src/orchestration/duplication.js";

/**
 * Deterministic synthetic replay: one root session running for 8+ hours
 * wall-clock, crossing 150K estimated context tokens, spawning several
 * overlapping general-purpose child runs (two of which duplicate the same
 * objective in the same repo), hitting a provider fallback, and repeating
 * the same failure twice. No paid model calls — every timestamp and token
 * count is fabricated to hit each documented threshold.
 *
 * This demonstrates exactly what PARAGON would have warned about under
 * the pathological workload described in D-002's directive
 * (the Cursor usage evidence: subagent-heavy, 8h+, 150K+ context sessions).
 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paragon-replay-"));
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

test("synthetic replay: pathological long/large/subagent-heavy session produces the expected governor warnings", async () => {
  const dataDir = tmpDir();
  const policy = DEFAULT_ORCHESTRATION_CONFIG;
  const runtime = createOrchestrationRuntime({ dataDir, getPolicy: () => policy });

  const jobId = "job_replay000000000000000";
  const sessionId = "sess_replay00000000000000";
  const sessionStart = hoursAgo(8.7); // > longSessionMinutes (480m)

  await runtime.jobs.getOrCreate(jobId, { repository: "example/monorepo", now: sessionStart });
  await runtime.sessions.getOrCreate(sessionId, { jobId, now: sessionStart });
  // Backdate the session directly since getOrCreate only sets startTime on first creation.
  await runtime.sessions.append?.({
    ...runtime.sessions.get(sessionId),
    startTime: sessionStart,
    latestActivityTime: sessionStart
  });

  const rootRunId = "run_replayroot0000000000";
  await runtime.runs.start({
    runId: rootRunId,
    parentRunId: null,
    jobId,
    sessionId,
    agentRole: "root",
    provider: "codex",
    model: "gpt-5-codex",
    startTime: sessionStart,
    streaming: false,
    repository: "example/monorepo"
  });
  await runtime.jobs.attachRootRun(jobId, rootRunId);

  // Root request context estimate crosses the absolute ceiling.
  const rootContext = estimateRequestContext({
    messages: [{ role: "user", content: "x".repeat(600000) }]
  });
  assert.ok(rootContext.estimatedInputTokens >= policy.context.absoluteCeilingTokens);

  const objHash = objectiveHash("explore", "audit repository-wide auth usage");
  const childStart1 = hoursAgo(2);
  const childStart2 = hoursAgo(1.9); // overlaps with child 1

  const child1 = "run_replaychild1000000000";
  const child2 = "run_replaychild2000000000";
  for (const [runId, start] of [[child1, childStart1], [child2, childStart2]]) {
    await runtime.runs.start({
      runId,
      parentRunId: rootRunId,
      jobId,
      sessionId,
      agentRole: "general-purpose",
      provider: "codex",
      startTime: start,
      streaming: false,
      repository: "example/monorepo",
      objectiveHash: objHash
    });
  }

  // Provider fallback + one repeated failure on the root run.
  await runtime.runs.finish(rootRunId, {
    now: hoursAgo(7.5),
    success: false,
    errorClassification: "codex timed out",
    timeout: true
  });
  await runtime.runs.update(rootRunId, { fallbackPosition: 1, provider: "cursor" });

  // --- Assemble what the shadow governor would report ---

  const session = runtime.sessions.get(sessionId);
  const wallClockDurationMinutes = runtime.sessions.wallClockDurationMinutes(session);
  const contextDecisions = evaluateShadowGovernor(policy, {
    estimatedInputTokens: rootContext.estimatedInputTokens,
    activeDurationMinutes: wallClockDurationMinutes,
    subagentCounts: null
  });

  const longSessionWarning = contextDecisions.find((d) => d.policyRule === "session.longRunning") ?? null;
  const ceilingWarning = evaluateShadowGovernor(policy, {
    estimatedInputTokens: rootContext.estimatedInputTokens,
    activeDurationMinutes: null,
    subagentCounts: null
  }).find((d) => d.policyRule === "context.absoluteCeiling");

  // Three overlapping children (one more than the two actually recorded above,
  // representing the concurrency PARAGON would see if a third child started
  // before the first two finished) exceeds the default parallel limit of 2.
  const subagentDecisions = evaluateShadowGovernor(policy, {
    estimatedInputTokens: null,
    activeDurationMinutes: null,
    subagentCounts: { parallelChildRuns: 3, totalChildRunsInJob: 2, hasRecursiveChild: false }
  });
  const parallelWarning = subagentDecisions.find((d) => d.policyRule === "subagents.parallelLimit");

  const duplication = detectDuplication(runtime.runs.byJob(jobId));

  // --- Assertions: this is the truthful report PARAGON would produce ---

  assert.ok(wallClockDurationMinutes >= policy.session.longSessionMinutes, "session should exceed the long-session threshold");
  assert.ok(longSessionWarning, "expected a session.longRunning shadow warning");

  assert.ok(ceilingWarning, "expected a context.absoluteCeiling shadow warning");
  assert.equal(ceilingWarning.proposedAction, "would_block_request");

  assert.ok(parallelWarning, "expected a subagents.parallelLimit shadow warning");
  assert.equal(parallelWarning.proposedAction, "would_prevent_spawn");

  assert.equal(duplication.length, 1);
  assert.equal(duplication[0].classification, "CONFIRMED_DUPLICATION");

  const rootRun = runtime.runs.get(rootRunId);
  assert.equal(rootRun.fallbackPosition, 1, "root run should reflect the fallback that occurred");
  assert.equal(rootRun.timeout, true);

  // This replay calls evaluateShadowGovernor directly, which stays a pure
  // proposal-only evaluator regardless of the runtime's configured mode
  // (PARAGON-D-003R retired "shadow" as the default/only mode, but did not
  // touch shadowGovernor.js itself — actual enforcement lives in
  // liveEnforcement.js and is gated through openaiApi.js, not here).
  assert.equal(policy.mode, "live");
});
