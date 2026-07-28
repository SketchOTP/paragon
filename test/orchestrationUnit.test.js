import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateId, isValidId, acceptOrGenerateId } from "../src/orchestration/ids.js";
import { redactSecrets, hashContent } from "../src/orchestration/redaction.js";
import { estimateRequestContext, estimateResponseSize } from "../src/orchestration/contextEstimator.js";
import { evaluateContext, evaluateSessionDuration, evaluateSubagents } from "../src/orchestration/shadowGovernor.js";
import { DEFAULT_ORCHESTRATION_CONFIG, validatePolicy, mergeOrchestrationConfig } from "../src/orchestration/governorPolicy.js";
import { extractCorrelation } from "../src/orchestration/correlation.js";
import { createEventStore } from "../src/orchestration/eventStore.js";
import { buildUsageSummary, contextBandFor, sessionDurationBandFor } from "../src/orchestration/usageLedger.js";
import { detectDuplication, objectiveHash } from "../src/orchestration/duplication.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paragon-orch-test-"));
}

// --- ids ---

test("generateId produces structurally valid, collision-resistant ids", () => {
  const a = generateId("job");
  const b = generateId("job");
  assert.notEqual(a, b);
  assert.ok(isValidId(a));
  assert.match(a, /^job_[0-9a-f]{24}$/);
});

test("acceptOrGenerateId preserves a valid supplied id and rejects garbage", () => {
  const valid = generateId("run");
  assert.equal(acceptOrGenerateId("run", valid), valid);
  const generated = acceptOrGenerateId("run", "not-an-id; DROP TABLE");
  assert.ok(isValidId(generated));
  assert.notEqual(generated, "not-an-id; DROP TABLE");
});

// --- redaction ---

test("redactSecrets redacts credential-shaped keys but not token-count metrics", () => {
  const out = redactSecrets({
    apiKey: "sk-abc123",
    accessToken: "abc",
    estimatedInputTokens: 4521,
    nested: { password: "hunter2", requestCount: 3 }
  });
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.accessToken, "[REDACTED]");
  assert.equal(out.estimatedInputTokens, 4521);
  assert.equal(out.nested.password, "[REDACTED]");
  assert.equal(out.nested.requestCount, 3);
});

test("redactSecrets scrubs bearer tokens embedded in string values", () => {
  const out = redactSecrets("curl -H 'Authorization: Bearer abcdefgh12345678'");
  assert.doesNotMatch(out, /abcdefgh12345678/);
});

test("hashContent is deterministic and bounded", () => {
  assert.equal(hashContent("same input"), hashContent("same input"));
  assert.notEqual(hashContent("a"), hashContent("b"));
  assert.equal(hashContent("x").length, 16);
});

// --- context estimator ---

test("estimateRequestContext never claims exactness", () => {
  const estimate = estimateRequestContext({ messages: [{ role: "user", content: "hello world" }] });
  assert.equal(estimate.isExact, false);
  assert.equal(estimate.method, "char-heuristic");
  assert.ok(estimate.estimatedInputTokens > 0);
});

test("estimateRequestContext accounts for tool schemas separately", () => {
  const withTools = estimateRequestContext({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }]
  });
  assert.ok(withTools.toolSchemaContributionTokens > 0);
});

test("estimateResponseSize handles empty text", () => {
  const estimate = estimateResponseSize("");
  assert.equal(estimate.estimatedOutputTokens, 0);
});

// --- shadow governor ---

test("evaluateContext proposes nothing below the warning threshold", () => {
  assert.deepEqual(evaluateContext(DEFAULT_ORCHESTRATION_CONFIG, 1000), []);
});

test("evaluateContext escalates rule severity as tokens climb through thresholds", () => {
  const warn = evaluateContext(DEFAULT_ORCHESTRATION_CONFIG, 85000);
  assert.equal(warn[0].policyRule, "context.warning");

  const checkpoint = evaluateContext(DEFAULT_ORCHESTRATION_CONFIG, 105000);
  assert.equal(checkpoint[0].policyRule, "context.checkpoint");

  const rollover = evaluateContext(DEFAULT_ORCHESTRATION_CONFIG, 125000);
  assert.equal(rollover[0].policyRule, "context.rollover");

  const ceiling = evaluateContext(DEFAULT_ORCHESTRATION_CONFIG, 160000);
  assert.equal(ceiling[0].policyRule, "context.absoluteCeiling");
  assert.equal(ceiling[0].proposedAction, "would_block_request");
});

test("evaluateSessionDuration proposes rollover past the configured window", () => {
  const decisions = evaluateSessionDuration(DEFAULT_ORCHESTRATION_CONFIG, 130);
  assert.equal(decisions[0].policyRule, "session.rollover");
});

test("evaluateSubagents flags parallel and total limits without enforcing them", () => {
  const decisions = evaluateSubagents(DEFAULT_ORCHESTRATION_CONFIG, {
    parallelChildRuns: 5,
    totalChildRunsInJob: 10,
    hasRecursiveChild: true
  });
  const rules = decisions.map((d) => d.policyRule);
  assert.ok(rules.includes("subagents.parallelLimit"));
  assert.ok(rules.includes("subagents.totalPerJobLimit"));
  assert.ok(rules.includes("subagents.recursiveChildrenProhibited"));
  for (const d of decisions) {
    assert.notEqual(d.proposedAction, "blocked");
  }
});

// --- governor policy validation ---

test("validatePolicy rejects any enforcement mode beyond off/shadow", () => {
  const { ok, errors } = validatePolicy({ ...DEFAULT_ORCHESTRATION_CONFIG, mode: "enforce" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("mode")));
});

test("validatePolicy accepts the shipped default", () => {
  const { ok } = validatePolicy(DEFAULT_ORCHESTRATION_CONFIG);
  assert.equal(ok, true);
});

test("mergeOrchestrationConfig deep-merges nested sections", () => {
  const merged = mergeOrchestrationConfig(DEFAULT_ORCHESTRATION_CONFIG, { context: { warningTokens: 1000 } });
  assert.equal(merged.context.warningTokens, 1000);
  assert.equal(merged.context.rolloverTokens, DEFAULT_ORCHESTRATION_CONFIG.context.rolloverTokens);
});

// --- correlation ---

test("extractCorrelation generates ids for a request with no headers at all", () => {
  const correlation = extractCorrelation({});
  assert.ok(isValidId(correlation.jobId));
  assert.ok(isValidId(correlation.sessionId));
  assert.ok(isValidId(correlation.runId));
  assert.equal(correlation.sessionIsImplicit, true);
  assert.equal(correlation.agentRole, "unknown");
});

test("extractCorrelation preserves valid supplied ids and role", () => {
  const sessionId = generateId("session");
  const correlation = extractCorrelation({
    "x-paragon-session-id": sessionId,
    "x-paragon-agent-role": "implementer"
  });
  assert.equal(correlation.sessionId, sessionId);
  assert.equal(correlation.sessionIsImplicit, false);
  assert.equal(correlation.agentRole, "implementer");
});

test("extractCorrelation discards malformed ids instead of throwing", () => {
  const correlation = extractCorrelation({ "x-paragon-run-id": "'; DROP TABLE runs; --" });
  assert.ok(isValidId(correlation.runId));
});

// --- event store: persistence, partial-line recovery, corrupt-line isolation ---

test("createEventStore persists and reloads records across instances", async () => {
  const dir = tmpDir();
  const store1 = createEventStore({ name: "widgets", dataDir: dir });
  await store1.append({ id: "widget_1", value: "a" });
  await store1.append({ id: "widget_1", value: "b" });

  const store2 = createEventStore({ name: "widgets", dataDir: dir });
  assert.equal(store2.get("widget_1").value, "b");
});

test("createEventStore recovers from a partially-written final line", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "widgets.jsonl"),
    `${JSON.stringify({ id: "widget_1", value: "a" })}\n{"id": "widget_2", "valu`
  );
  const store = createEventStore({ name: "widgets", dataDir: dir });
  assert.equal(store.get("widget_1").value, "a");
  assert.equal(store.get("widget_2"), undefined);
});

test("createEventStore isolates a corrupt middle line without losing surrounding records", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "widgets.jsonl"),
    [JSON.stringify({ id: "widget_1", value: "a" }), "{not json at all", JSON.stringify({ id: "widget_2", value: "b" })].join(
      "\n"
    ) + "\n"
  );
  const store = createEventStore({ name: "widgets", dataDir: dir });
  assert.equal(store.get("widget_1").value, "a");
  assert.equal(store.get("widget_2").value, "b");
});

test("createEventStore starts safely with no file on disk at all", () => {
  const dir = tmpDir();
  const store = createEventStore({ name: "nothing-yet", dataDir: dir });
  assert.deepEqual(store.all(), []);
});

test("createEventStore redacts secrets before persisting to disk", async () => {
  const dir = tmpDir();
  const store = createEventStore({ name: "widgets", dataDir: dir });
  await store.append({ id: "widget_1", apiKey: "super-secret" });
  const raw = fs.readFileSync(path.join(dir, "widgets.jsonl"), "utf8");
  assert.doesNotMatch(raw, /super-secret/);
});

test("createEventStore compactWithRetention drops records past the retention window", async () => {
  const dir = tmpDir();
  const store = createEventStore({ name: "widgets", dataDir: dir });
  await store.append({ id: "widget_old", createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() });
  await store.append({ id: "widget_new", createdAt: new Date().toISOString() });
  const removed = await store.compactWithRetention(30);
  assert.equal(removed, 1);
  assert.equal(store.get("widget_old"), undefined);
  assert.ok(store.get("widget_new"));
});

// --- usage ledger ---

test("contextBandFor and sessionDurationBandFor cover the required bands", () => {
  assert.equal(contextBandFor(10000), "<32K");
  assert.equal(contextBandFor(90000), "80K–100K");
  assert.equal(contextBandFor(200000), ">150K");
  assert.equal(sessionDurationBandFor(15), "<30m");
  assert.equal(sessionDurationBandFor(500), "8h+");
});

test("buildUsageSummary aggregates root/child, provider, and success/failure counts", () => {
  const runs = [
    { provider: "codex", model: "m1", jobId: "j1", sessionId: "s1", agentRole: "root", parentRunId: null, success: true, fallbackPosition: 0, timeout: false, requestContextEstimate: { estimatedInputTokens: 5000 } },
    { provider: "codex", model: "m1", jobId: "j1", sessionId: "s1", agentRole: "general-purpose", parentRunId: "run_x", success: false, fallbackPosition: 1, timeout: true, requestContextEstimate: { estimatedInputTokens: 200000 } }
  ];
  const summary = buildUsageSummary({ runs, sessions: [] });
  assert.equal(summary.byRootVsChild.root, 1);
  assert.equal(summary.byRootVsChild.child, 1);
  assert.equal(summary.bySuccessFailure.success, 1);
  assert.equal(summary.bySuccessFailure.failure, 1);
  assert.equal(summary.byFallback.fallback, 1);
  assert.equal(summary.byTimeout.timeout, 1);
  assert.equal(summary.byContextBand[">150K"], 1);
});

// --- duplication signals ---

test("objectiveHash is stable for identical task/objective pairs", () => {
  assert.equal(objectiveHash("explore", "find the auth module"), objectiveHash("explore", "find the auth module"));
  assert.notEqual(objectiveHash("explore", "a"), objectiveHash("explore", "b"));
});

test("detectDuplication only reaches CONFIRMED_DUPLICATION with repo + time-overlap corroboration", () => {
  const hash = objectiveHash("explore", "find the auth module");
  const now = new Date().toISOString();
  const runs = [
    { id: "run_a", sessionId: "s1", parentRunId: "run_root", objectiveHash: hash, repository: "repo1", startTime: now, endTime: null },
    { id: "run_b", sessionId: "s1", parentRunId: "run_root", objectiveHash: hash, repository: "repo1", startTime: now, endTime: null }
  ];
  const signals = detectDuplication(runs);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].classification, "CONFIRMED_DUPLICATION");
});

test("detectDuplication reports INSUFFICIENT_EVIDENCE without repo or time corroboration", () => {
  const hash = objectiveHash("explore", "find the auth module");
  const runs = [
    { id: "run_a", sessionId: "s1", parentRunId: "run_root", objectiveHash: hash, repository: "repo1", startTime: "2020-01-01T00:00:00Z", endTime: "2020-01-01T00:01:00Z" },
    { id: "run_b", sessionId: "s1", parentRunId: "run_root", objectiveHash: hash, repository: "repo2", startTime: "2021-01-01T00:00:00Z", endTime: "2021-01-01T00:01:00Z" }
  ];
  const signals = detectDuplication(runs);
  assert.equal(signals[0].classification, "INSUFFICIENT_EVIDENCE");
});
