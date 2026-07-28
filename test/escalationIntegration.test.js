import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const badJsonFixture = path.join(__dirname, "fixtures", "echo-not-json.js");
const goodJsonFixture = path.join(__dirname, "fixtures", "echo-json.js");

const PORT = 4942;
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

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra };
}

test.before(async () => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-escalation-integ-"));
  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: { ...process.env, PARAGON_HOST: "127.0.0.1", PARAGON_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  const raw = fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8");
  apiKey = JSON.parse(raw).server.apiKey;

  const configRes = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await configRes.json();
  config.providers.badjson = {
    type: "generic-cli",
    label: "Bad JSON fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [badJsonFixture],
    model: "fixture-model",
    models: [{ id: "fixture-model", name: "fixture-model" }],
    timeoutMs: 10000
  };
  config.providers.goodjson = {
    type: "generic-cli",
    label: "Good JSON fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [goodJsonFixture],
    model: "fixture-model",
    models: [{ id: "fixture-model", name: "fixture-model" }],
    timeoutMs: 10000
  };
  // Bias the scorer toward badjson for every task so the test is
  // deterministic about which fixture is tried first.
  for (const t of Object.keys(config.routing.taskRoutes)) {
    config.routing.taskRoutes[t] = "badjson";
  }
  config.routing.defaultProvider = "badjson";
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

test("a response_format:json_object request escalates past a provider that returned non-JSON, distinct from service-failure fallback", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "paragon",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "give me json" }]
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paragon.provider, "goodjson", "must have escalated to the fixture that actually returns valid json");
  assert.doesNotThrow(() => JSON.parse(body.choices[0].message.content));

  const logsRes = await fetch(`${BASE}/api/logs`, { headers: authHeaders() });
  const logs = (await logsRes.json()).logs;
  const escalationLog = logs.find((l) => l.type === "escalation" && l.provider === "badjson");
  assert.ok(escalationLog, "the escalation must be logged with type 'escalation', not folded into generic fallback logging");
  assert.match(escalationLog.message, /json validation/i);
});

test("a plain request (no response_format) does not trigger escalation even against the same non-JSON-producing provider", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paragon.provider, "badjson", "without a json response_format, plain text output is valid and must not escalate");
});
