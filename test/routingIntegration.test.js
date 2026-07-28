import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PORT = 4931;
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
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-routing-integ-"));
  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: { ...process.env, PARAGON_HOST: "127.0.0.1", PARAGON_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  const raw = fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8");
  apiKey = JSON.parse(raw).server.apiKey;
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra };
}

test("every chat completion response reports which route/model was actually chosen", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.ok(res.headers.get("x-paragon-route-reason"), "must report why this route was chosen, not just what");
  // route-model may be empty string in this hermetic sandbox (no models
  // discovered for any provider without real CLI auth) but the header
  // itself must always be present.
  assert.notEqual(res.headers.get("x-paragon-route-model"), null);
  await res.json().catch(() => {});
});

test("x-paragon-force-provider hint is honored and visible in telemetry, even in a fresh unauthenticated sandbox", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "X-Paragon-Force-Provider": "codex" }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(res.headers.get("x-paragon-route-reason"), "hint.forceProvider");
  await res.json().catch(() => {});
});

test("antigravity is never chosen by automatic routing even when enabled, only via an explicit force hint", async () => {
  const configRes = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await configRes.json();
  config.providers.antigravity.enabled = true;
  // Bias every task route toward antigravity — if automatic eligibility
  // were only a soft scoring signal instead of a hard gate, this would be
  // enough to make it win.
  for (const task of Object.keys(config.routing.taskRoutes)) {
    config.routing.taskRoutes[task] = "antigravity";
  }
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "implement a function" }] })
  });
  const runId = res.headers.get("x-paragon-run-id");
  await res.json().catch(() => {});

  const runRes = await fetch(`${BASE}/api/orchestration/runs/${runId}`, { headers: authHeaders() });
  const run = await runRes.json();
  assert.notEqual(run.provider, "antigravity");

  // Forcing it explicitly must still work — the gate is "not automatic," not "never reachable."
  const forcedRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "X-Paragon-Force-Provider": "antigravity" }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(forcedRes.headers.get("x-paragon-route-reason"), "hint.forceProvider");
});
