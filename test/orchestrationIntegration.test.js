import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { seedCatalogFile } from "./helpers/seedCatalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const echoJsonFixture = path.join(__dirname, "fixtures", "echo-json.js");

const PORT = 4919;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let apiKey;
let tmpCwd;

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy in time");
}

test.before(async () => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-orch-integ-"));
  // PARAGON-D-004C1 (P0-1/P0-4): routing now requires a catalog-eligible
  // model, so these telemetry tests get a local fixture provider rather
  // than depending on a real installed CLI. Seeded before the server starts
  // because the catalog is loaded at startup.
  seedCatalogFile(tmpCwd, { fixturep: ["fixture-model"] });
  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: { ...process.env, PARAGON_HOST: "127.0.0.1", PARAGON_PORT: String(PORT), PARAGON_MODEL_CATALOG_ENABLED: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  const raw = fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8");
  apiKey = JSON.parse(raw).server.apiKey;

  const configRes = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await configRes.json();
  config.providers.fixturep = {
    type: "generic-cli",
    label: "Orchestration fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [echoJsonFixture],
    model: "fixture-model",
    models: [{ id: "fixture-model", name: "fixture-model" }],
    timeoutMs: 10000
  };
  // The seeded catalog contains only this fixture provider, so automatic
  // routing has exactly one eligible candidate.
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra };
}

test("/v1/models is unchanged by orchestration instrumentation", async () => {
  const res = await fetch(`${BASE}/v1/models`, { headers: authHeaders() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data[0].id, "paragon");
  assert.equal(body.data[1].id, "routerbot-local");
});

test("chat completion with no correlation headers still returns orchestration response headers", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.ok(res.headers.get("x-paragon-job-id"));
  assert.ok(res.headers.get("x-paragon-session-id"));
  assert.ok(res.headers.get("x-paragon-run-id"));
  // Default orchestration mode is "live" as of PARAGON-D-003R (shadow is a
  // migrate-only legacy value, never a fresh default).
  assert.equal(res.headers.get("x-paragon-enforcement-mode"), "live");
  // No CLI providers are authenticated in this sandbox, so the request itself
  // fails — that's expected and orthogonal to what this test verifies.
  await res.json();
});

test("chat completion with full correlation headers is recorded under the supplied session", async () => {
  const sessionId = "sess_aaaaaaaaaaaaaaaaaaaaaaaa";
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({
      "X-Paragon-Session-ID": sessionId,
      "X-Paragon-Agent-Role": "implementer",
      "X-Paragon-Repository": "example/repo"
    }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello again" }] })
  });
  assert.equal(res.headers.get("x-paragon-session-id"), sessionId);
  await res.json();

  const sessionRes = await fetch(`${BASE}/api/orchestration/sessions/${sessionId}`, { headers: authHeaders() });
  assert.equal(sessionRes.status, 200);
  const session = await sessionRes.json();
  assert.equal(session.id, sessionId);
  assert.ok(session.requestCount >= 1);
});

test("streaming request completes and is still recorded as a run", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", stream: true, messages: [{ role: "user", content: "stream please" }] })
  });
  const runId = res.headers.get("x-paragon-run-id");
  assert.ok(runId);
  // Drain the stream so the connection closes cleanly.
  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
  const runRes = await fetch(`${BASE}/api/orchestration/runs/${runId}`, { headers: authHeaders() });
  const run = await runRes.json();
  assert.equal(run.streaming, true);
  assert.notEqual(run.success, null);
});

test("unknown agent role falls back to \"unknown\" rather than guessing", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "X-Paragon-Agent-Role": "totally-made-up-role" }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hi" }] })
  });
  const runId = res.headers.get("x-paragon-run-id");
  await res.json();
  const runRes = await fetch(`${BASE}/api/orchestration/runs/${runId}`, { headers: authHeaders() });
  const run = await runRes.json();
  assert.equal(run.agentRole, "unknown");
});

// Note: the absolute-ceiling decision path (evaluateContext at 150K+ tokens)
// is covered at the unit level in orchestrationUnit.test.js rather than here.
// Triggering it over real HTTP requires piping a 500K+ character prompt to a
// live provider child process; in this sandbox no CLI provider is
// authenticated, and that combination surfaces a pre-existing unhandled-EPIPE
// crash in src/cli.js's runProcess() (stdin write to an already-closed pipe)
// that predates and is unrelated to D-002. See ORCHESTRATION_FOUNDATION.md
// "Known limitations" — fixing it is out of scope for this directive because
// it touches provider execution code.

test("admin orchestration API requires authentication for non-loopback callers", async () => {
  // The existing admin middleware allows unauthenticated loopback access by
  // design (createAuthMiddleware allowLocalhost:true) — simulate a remote
  // caller via X-Forwarded-For, which the app's own clientIp() honors, to
  // exercise the actual auth-required path.
  const res = await fetch(`${BASE}/api/orchestration/status`, {
    headers: { "X-Forwarded-For": "203.0.113.5" }
  });
  assert.equal(res.status, 401);
});

test("dashboard API returns bounded, paginated results", async () => {
  const res = await fetch(`${BASE}/api/orchestration/runs?limit=2`, { headers: authHeaders() });
  const body = await res.json();
  assert.ok(body.items.length <= 2);
  assert.equal(body.limit, 2);
});

test("PUT policy rejects an enforcement mode outside off/live", async () => {
  const res = await fetch(`${BASE}/api/orchestration/policy`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ mode: "enforce" })
  });
  assert.equal(res.status, 400);
});

test("PUT policy rejects the legacy shadow value directly (migration-only, not a valid write)", async () => {
  const res = await fetch(`${BASE}/api/orchestration/policy`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ mode: "shadow" })
  });
  assert.equal(res.status, 400);
});

test("live mode actually blocks a request whose estimated context exceeds the absolute ceiling", async () => {
  const policyRes = await fetch(`${BASE}/api/orchestration/policy`, { headers: authHeaders() });
  const policy = await policyRes.json();
  assert.equal(policy.mode, "live", "default mode must be live for this to be a real enforcement test");

  const oversized = "x".repeat(policy.context.absoluteCeilingTokens * 4);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: oversized }] })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, "paragon_live_enforcement_error");
  assert.equal(body.error.code, "context.absoluteCeiling");

  const runId = res.headers.get("x-paragon-run-id");
  assert.ok(runId);
  const runRes = await fetch(`${BASE}/api/orchestration/runs/${runId}`, { headers: authHeaders() });
  const run = await runRes.json();
  assert.equal(run.success, false, "the blocked request must still appear in Activity as a bounded failure");

  const decisionsRes = await fetch(`${BASE}/api/orchestration/decisions?limit=5`, { headers: authHeaders() });
  const decisions = await decisionsRes.json();
  const blocked = decisions.items.find((d) => d.runId === runId && d.policyRule === "context.absoluteCeiling");
  assert.ok(blocked, "the enforcement must appear in Governor Actions");
  assert.match(blocked.explanation, /^ENFORCED \(live mode\)/);
});

test("POST checkpoint persists and is retrievable via jobs/sessions", async () => {
  const statusRes = await fetch(`${BASE}/api/orchestration/jobs?limit=1`, { headers: authHeaders() });
  const jobs = await statusRes.json();
  assert.ok(jobs.items.length >= 1);
  const job = jobs.items[0];

  const res = await fetch(`${BASE}/api/orchestration/checkpoints`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      jobId: job.id,
      sessionId: job.sessionIds[0],
      activeObjective: "test checkpoint",
      completedWorkSummary: "did a thing"
    })
  });
  assert.equal(res.status, 201);
  const checkpoint = await res.json();
  assert.equal(checkpoint.completeness, "complete");
});
