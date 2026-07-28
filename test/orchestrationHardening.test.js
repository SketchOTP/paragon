import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOrchestrationRuntime } from "../src/orchestration/telemetry.js";
import { DEFAULT_ORCHESTRATION_CONFIG } from "../src/orchestration/governorPolicy.js";
import { evaluateShadowGovernor } from "../src/orchestration/shadowGovernor.js";
import { correlationResponseHeaders, extractCorrelation } from "../src/orchestration/correlation.js";
import { classifyError, boundedDiagnostic } from "../src/orchestration/errorClassification.js";
import { objectiveHash, detectDuplication } from "../src/orchestration/duplication.js";
import { createBoundedResponseAccumulator } from "../src/orchestration/contextEstimator.js";
import { createEventStore } from "../src/orchestration/eventStore.js";
import { generateId } from "../src/orchestration/ids.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paragon-hardening-"));
}

function runtime(policyOverrides = {}) {
  const policy = { ...DEFAULT_ORCHESTRATION_CONFIG, ...policyOverrides };
  return createOrchestrationRuntime({ dataDir: tmpDir(), getPolicy: () => policy });
}

// --- 4. Implicit session/job lifecycle closure ---

test("an untagged (implicit-session) request closes its session and job once finished", async () => {
  const rt = runtime();
  const telemetry = await rt.beginRequest({}, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(telemetry.correlation.sessionIsImplicit, true);

  assert.equal(rt.sessions.get(telemetry.correlation.sessionId).status, "active");
  assert.equal(rt.jobs.get(telemetry.correlation.jobId).status, "active");

  await rt.finishRequest(telemetry, { success: true, provider: "codex", model: "m", responseText: "ok" });

  assert.equal(rt.sessions.get(telemetry.correlation.sessionId).status, "closed");
  assert.equal(rt.jobs.get(telemetry.correlation.jobId).status, "closed");
});

test("a failed untagged request still closes its implicit session", async () => {
  const rt = runtime();
  const telemetry = await rt.beginRequest({}, { messages: [{ role: "user", content: "hi" }] });
  await rt.finishRequest(telemetry, { success: false, errorClassification: "UNKNOWN" });
  assert.equal(rt.sessions.get(telemetry.correlation.sessionId).status, "closed");
});

test("a streaming untagged request closes its implicit session once finished", async () => {
  const rt = runtime();
  const telemetry = await rt.beginRequest({}, { messages: [{ role: "user", content: "hi" }], stream: true });
  const acc = createBoundedResponseAccumulator();
  acc.push("partial output");
  await rt.finishRequest(telemetry, { success: true, provider: "codex", responseEstimate: acc.finish() });
  assert.equal(rt.sessions.get(telemetry.correlation.sessionId).status, "closed");
});

test("an explicit caller-supplied session stays open after its request finishes", async () => {
  const rt = runtime();
  const sessionId = generateId("session");
  const telemetry = await rt.beginRequest(
    { "x-paragon-session-id": sessionId },
    { messages: [{ role: "user", content: "hi" }] }
  );
  assert.equal(telemetry.correlation.sessionIsImplicit, false);
  await rt.finishRequest(telemetry, { success: true, provider: "codex", responseText: "ok" });
  assert.equal(rt.sessions.get(sessionId).status, "active");
});

test("status aggregation returns to zero active sessions/jobs after implicit traffic completes", async () => {
  const rt = runtime();
  for (let i = 0; i < 3; i += 1) {
    const telemetry = await rt.beginRequest({}, { messages: [{ role: "user", content: `hi ${i}` }] });
    await rt.finishRequest(telemetry, { success: true, provider: "codex", responseText: "ok" });
  }
  const activeSessions = rt.sessions.all().filter((s) => s.status === "active");
  const activeJobs = rt.jobs.all().filter((j) => j.status === "active");
  assert.equal(activeSessions.length, 0);
  assert.equal(activeJobs.length, 0);
  // Historical records are preserved, not deleted.
  assert.equal(rt.sessions.all().length, 3);
  assert.equal(rt.jobs.all().length, 3);
});

test("server restart (fresh runtime over the same data dir) still sees closed implicit sessions as closed", async () => {
  const dir = tmpDir();
  const policy = DEFAULT_ORCHESTRATION_CONFIG;
  const rt1 = createOrchestrationRuntime({ dataDir: dir, getPolicy: () => policy });
  const telemetry = await rt1.beginRequest({}, { messages: [{ role: "user", content: "hi" }] });
  await rt1.finishRequest(telemetry, { success: true, provider: "codex", responseText: "ok" });

  const rt2 = createOrchestrationRuntime({ dataDir: dir, getPolicy: () => policy });
  assert.equal(rt2.sessions.get(telemetry.correlation.sessionId).status, "closed");
});

// --- 5. Duration terminology ---

test("wallClockDurationMinutes, activeProviderDurationMinutes, and idleDurationMinutes are distinct", async () => {
  const rt = runtime();
  const sessionId = generateId("session");
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago
  await rt.sessions.getOrCreate(sessionId, { jobId: generateId("job"), now: start });
  await rt.sessions.append({ ...rt.sessions.get(sessionId), startTime: start });
  // Simulate 5 minutes of actual provider execution time accumulated.
  await rt.sessions.recordActivity(sessionId, { now: new Date().toISOString(), activeDurationDeltaMs: 5 * 60 * 1000 });

  const session = rt.sessions.get(sessionId);
  const wallClock = rt.sessions.wallClockDurationMinutes(session);
  const active = rt.sessions.activeProviderDurationMinutes(session);
  const idle = rt.sessions.idleDurationMinutes(session);

  assert.ok(wallClock >= 59 && wallClock <= 61, `expected ~60 wall-clock minutes, got ${wallClock}`);
  assert.equal(active, 5);
  assert.ok(idle >= 54 && idle <= 56, `expected ~55 idle minutes, got ${idle}`);
});

test("governor session thresholds compare against wall-clock duration, not active provider duration", async () => {
  // A session with almost no actual provider execution time but a long
  // wall-clock span (e.g. waiting on an external process) must still be
  // flagged by the long-session warning — this is what the directive's
  // "8+ hour Cursor sessions" evidence describes.
  const decisions = evaluateShadowGovernor(DEFAULT_ORCHESTRATION_CONFIG, {
    estimatedInputTokens: null,
    activeDurationMinutes: 500, // wall-clock
    subagentCounts: null
  });
  assert.ok(decisions.some((d) => d.policyRule === "session.longRunning"));
});

// --- 6. Duplication signal hardening ---

test("objectiveHash requires both task type and a final user message — no partial guesses", () => {
  assert.equal(objectiveHash(null, "some content"), null);
  assert.equal(objectiveHash("explore", null), null);
  assert.equal(objectiveHash(null, null), null);
  assert.ok(objectiveHash("explore", "find the auth module"));
});

test("a shared system prompt across children with different objectives is not treated as a duplicate", async () => {
  const rt = runtime();
  const sharedSystemPrompt = "You are a helpful coding agent operating in read-only mode.";
  const jobId = generateId("job");
  const sessionId = generateId("session");
  await rt.jobs.getOrCreate(jobId, { repository: "example/repo" });
  await rt.sessions.getOrCreate(sessionId, { jobId });
  const rootRunId = generateId("run");
  await rt.runs.start({ runId: rootRunId, parentRunId: null, jobId, sessionId, agentRole: "root", startTime: new Date().toISOString() });

  // Two children share messages[0] (the system prompt) but have distinct
  // final user-authored objectives — beginRequest must hash only the
  // final user message + task type, never messages[0].
  const child1 = await rt.beginRequest(
    { "x-paragon-job-id": jobId, "x-paragon-session-id": sessionId, "x-paragon-parent-run-id": rootRunId, "x-paragon-task-type": "explore", "x-paragon-repository": "example/repo" },
    { messages: [{ role: "system", content: sharedSystemPrompt }, { role: "user", content: "audit the auth module" }] }
  );
  const child2 = await rt.beginRequest(
    { "x-paragon-job-id": jobId, "x-paragon-session-id": sessionId, "x-paragon-parent-run-id": rootRunId, "x-paragon-task-type": "explore", "x-paragon-repository": "example/repo" },
    { messages: [{ role: "system", content: sharedSystemPrompt }, { role: "user", content: "audit the billing module" }] }
  );

  assert.notEqual(child1.run.objectiveHash, child2.run.objectiveHash);
  const signals = detectDuplication(rt.runs.byJob(jobId));
  assert.equal(signals.length, 0);
});

test("two children with the same task type, same final user message, same repo, overlapping time are CONFIRMED_DUPLICATION", async () => {
  const rt = runtime();
  const jobId = generateId("job");
  const sessionId = generateId("session");
  await rt.jobs.getOrCreate(jobId, { repository: "example/repo" });
  await rt.sessions.getOrCreate(sessionId, { jobId });
  const rootRunId = generateId("run");
  await rt.runs.start({ runId: rootRunId, parentRunId: null, jobId, sessionId, agentRole: "root", startTime: new Date().toISOString() });

  const headers = { "x-paragon-job-id": jobId, "x-paragon-session-id": sessionId, "x-paragon-parent-run-id": rootRunId, "x-paragon-task-type": "explore", "x-paragon-repository": "example/repo" };
  const body = { messages: [{ role: "system", content: "shared" }, { role: "user", content: "audit the auth module" }] };
  const child1 = await rt.beginRequest(headers, body);
  const child2 = await rt.beginRequest(headers, body);

  assert.equal(child1.run.objectiveHash, child2.run.objectiveHash);
  const signals = detectDuplication(rt.runs.byJob(jobId));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].classification, "CONFIRMED_DUPLICATION");
});

// --- 7. Subagent count boundary correction ---

test("the total-child-run limit fires on the 5th child, not the 4th, with a limit of 4", async () => {
  const rt = runtime();
  const jobId = generateId("job");
  const sessionId = generateId("session");
  await rt.jobs.getOrCreate(jobId, {});
  await rt.sessions.getOrCreate(sessionId, { jobId });
  const rootRunId = generateId("run");
  await rt.runs.start({ runId: rootRunId, parentRunId: null, jobId, sessionId, agentRole: "root", startTime: new Date().toISOString() });

  const decisionCounts = [];
  for (let i = 0; i < 5; i += 1) {
    // Close each prior child immediately so only the total-limit rule (not
    // the parallel-limit rule) is exercised.
    const telemetry = await rt.beginRequest(
      { "x-paragon-job-id": jobId, "x-paragon-session-id": sessionId, "x-paragon-parent-run-id": rootRunId, "x-paragon-agent-role": "general-purpose" },
      { messages: [{ role: "user", content: `child ${i}` }] }
    );
    await rt.finishRequest(telemetry, { success: true, provider: "codex", responseText: "ok" });
    const fired = telemetry.decisions.some((d) => d.policyRule === "subagents.totalPerJobLimit");
    decisionCounts.push(fired);
  }
  // children are index 0..4 (5 total) — limit is 4, so only the 5th (index 4) should fire.
  assert.deepEqual(decisionCounts, [false, false, false, false, true]);
});

test("the parallel-child limit fires on the 3rd concurrently-open child, not the 2nd, with a limit of 2", async () => {
  const rt = runtime();
  const jobId = generateId("job");
  const sessionId = generateId("session");
  await rt.jobs.getOrCreate(jobId, {});
  await rt.sessions.getOrCreate(sessionId, { jobId });
  const rootRunId = generateId("run");
  await rt.runs.start({ runId: rootRunId, parentRunId: null, jobId, sessionId, agentRole: "root", startTime: new Date().toISOString() });

  const headers = { "x-paragon-job-id": jobId, "x-paragon-session-id": sessionId, "x-paragon-parent-run-id": rootRunId, "x-paragon-agent-role": "general-purpose" };
  // Start three children without finishing any — all three remain "open" concurrently.
  const t1 = await rt.beginRequest(headers, { messages: [{ role: "user", content: "1" }] });
  const t2 = await rt.beginRequest(headers, { messages: [{ role: "user", content: "2" }] });
  const t3 = await rt.beginRequest(headers, { messages: [{ role: "user", content: "3" }] });

  assert.equal(t1.decisions.some((d) => d.policyRule === "subagents.parallelLimit"), false);
  assert.equal(t2.decisions.some((d) => d.policyRule === "subagents.parallelLimit"), false);
  assert.equal(t3.decisions.some((d) => d.policyRule === "subagents.parallelLimit"), true);
});

// --- 8. Policy-mode header accuracy ---

test("X-Paragon-Enforcement-Mode reflects the configured mode, not a hardcoded value", () => {
  const correlation = extractCorrelation({});
  assert.equal(correlationResponseHeaders(correlation, "shadow")["X-Paragon-Enforcement-Mode"], "shadow");
  assert.equal(correlationResponseHeaders(correlation, "off")["X-Paragon-Enforcement-Mode"], "off");
});

test("mode:off produces zero governor decisions even for a clearly over-threshold request", async () => {
  const rt = runtime({ mode: "off" });
  const telemetry = await rt.beginRequest({}, { messages: [{ role: "user", content: "x".repeat(600000) }] });
  assert.equal(telemetry.decisions.length, 0);
  assert.equal(telemetry.responseHeaders["X-Paragon-Enforcement-Mode"], "off");
  assert.equal(telemetry.responseHeaders["X-Paragon-Governor-Warnings"], "0");
});

// --- 11. Storage: run-id collision must never overwrite an unrelated run ---

test("a client-supplied run id colliding with an existing unrelated run does not overwrite it", async () => {
  const rt = runtime();
  const existingRunId = generateId("run");
  await rt.runs.start({
    runId: existingRunId,
    parentRunId: null,
    jobId: generateId("job"),
    sessionId: generateId("session"),
    agentRole: "root",
    provider: "codex",
    startTime: new Date().toISOString()
  });
  const before = rt.runs.get(existingRunId);

  const telemetry = await rt.beginRequest(
    { "x-paragon-run-id": existingRunId },
    { messages: [{ role: "user", content: "different request entirely" }] }
  );

  // The new request must have been assigned a fresh id, not the collided one.
  assert.notEqual(telemetry.run.id, existingRunId);
  const after = rt.runs.get(existingRunId);
  assert.deepEqual(after, before);
});

test("50 concurrent appends to the same store all persist without loss or corruption", async () => {
  const dir = tmpDir();
  const store = createEventStore({ name: "concurrency", dataDir: dir });
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => store.append({ id: `item_${i}`, value: i }))
  );
  assert.equal(store.all().length, 50);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(store.get(`item_${i}`).value, i);
  }
});

// --- 10. Bounded failure classification ---

test("classifyError maps common failure shapes to the bounded taxonomy", () => {
  assert.equal(classifyError({ code: "EPIPE" }), "BROKEN_PIPE");
  assert.equal(classifyError(new Error("codex timed out after 300000ms")), "TIMEOUT");
  assert.equal(classifyError({ code: "ECONNREFUSED", message: "connect failed" }), "NETWORK");
  assert.equal(classifyError(new Error("401 Unauthorized")), "AUTHENTICATION");
  assert.equal(classifyError(new Error("429 rate limit exceeded")), "RATE_LIMIT");
  assert.equal(classifyError(new Error("totally novel failure mode")), "UNKNOWN");
});

test("boundedDiagnostic redacts secrets and truncates, never returning the raw unbounded message", () => {
  const longMessage = `failed with Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456 ${"x".repeat(1000)}`;
  const diagnostic = boundedDiagnostic(new Error(longMessage), 50);
  assert.ok(diagnostic.length <= 51); // 50 chars + ellipsis
  assert.doesNotMatch(diagnostic, /sk-abcdefghijklmnopqrstuvwxyz123456/);
});

// --- 1. Per-attempt telemetry ---

test("beginAttempt/finishAttempt record distinct attempt records per fallback try under one run", async () => {
  const rt = runtime();
  const telemetry = await rt.beginRequest({}, { messages: [{ role: "user", content: "hi" }] });
  const runId = telemetry.run.id;

  const attempt1 = await rt.beginAttempt(runId, { provider: "codex", model: "m1", fallbackPosition: 0 });
  await rt.finishAttempt(attempt1.id, {
    success: false,
    errorClassification: "TIMEOUT",
    fallbackReason: "failed, falling back to cursor",
    followedByAnotherAttempt: true
  });
  const attempt2 = await rt.beginAttempt(runId, { provider: "cursor", model: "m2", fallbackPosition: 1 });
  await rt.finishAttempt(attempt2.id, { success: true, followedByAnotherAttempt: false });

  const recorded = rt.attempts.byRun(runId);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].provider, "codex");
  assert.equal(recorded[0].success, false);
  assert.equal(recorded[0].followedByAnotherAttempt, true);
  assert.equal(recorded[1].provider, "cursor");
  assert.equal(recorded[1].success, true);
});
