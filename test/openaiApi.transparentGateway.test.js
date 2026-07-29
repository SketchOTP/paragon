import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { seedCatalogFile } from "./helpers/seedCatalog.js";

// PARAGON-D-004B-R: proves the corrective directive — Cursor (or any
// OpenAI-compatible client) needs only base URL + API key + model name.
// No workspace header is required, and every provider invocation runs in
// its own throwaway directory, never PARAGON's own checkout.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const echoCwdFixture = path.join(__dirname, "fixtures", "echo-cwd.js");

const PORT = 4953;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let apiKey;
let tmpCwd;
let runtimeRoot;

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

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra };
}

test.before(async () => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-transparent-integ-"));
  seedCatalogFile(tmpCwd, { echocwd: ["fixture-model"] });
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-transparent-runtime-"));
  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: {
      ...process.env,
      PARAGON_HOST: "127.0.0.1",
      PARAGON_PORT: String(PORT),
      PARAGON_RUNTIME_ROOT: runtimeRoot,
      PARAGON_MODEL_CATALOG_ENABLED: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  const raw = fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8");
  apiKey = JSON.parse(raw).server.apiKey;

  const configRes = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await configRes.json();
  config.providers.echocwd = {
    type: "generic-cli",
    label: "Echo cwd fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [echoCwdFixture],
    model: "fixture-model",
    models: [{ id: "fixture-model", name: "fixture-model" }],
    timeoutMs: 10000
  };
  for (const t of Object.keys(config.routing.taskRoutes)) {
    config.routing.taskRoutes[t] = "echocwd";
  }
  config.routing.defaultProvider = "echocwd";
  config.routing.fallbackChain = ["echocwd"];
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test("a standard request with no workspace header succeeds", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.choices[0].message.content);
});

test("the provider process runs inside an isolated runtime directory, never repoRoot or tmpCwd", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "where am I" }] })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const reportedCwd = body.choices[0].message.content.trim();
  assert.ok(
    reportedCwd.startsWith(path.resolve(runtimeRoot)),
    `expected provider cwd under runtime root, got ${reportedCwd}`
  );
  assert.notEqual(reportedCwd, path.resolve(repoRoot));
  assert.notEqual(reportedCwd, path.resolve(tmpCwd));
});

test("no X-Paragon-Workspace-* header is required or interpreted as an error condition", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "X-Paragon-Workspace-ID": "nonexistent-workspace" }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hi" }] })
  });
  // A stray/legacy header must be silently ignored, never rejected.
  assert.equal(res.status, 200);
});

test("GET /v1/models works with just the API key, no workspace setup", async () => {
  const res = await fetch(`${BASE}/v1/models`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.some((m) => m.id === "paragon"));
});

test("/api/workspaces is no longer part of the public surface", async () => {
  const res = await fetch(`${BASE}/api/workspaces`, { headers: authHeaders() });
  assert.equal(res.status, 404);
});
