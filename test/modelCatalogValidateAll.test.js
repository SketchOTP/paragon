import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const goodFixture = path.join(__dirname, "fixtures", "echo-json.js");
const notFoundFixture = path.join(__dirname, "fixtures", "echo-model-not-found.js");

const PORT = 4964;
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
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-validate-all-integ-"));
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
  config.providers.good = {
    type: "generic-cli",
    label: "Good fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [goodFixture],
    model: "good-model",
    models: [{ id: "good-model", name: "good-model" }],
    timeoutMs: 10000
  };
  config.providers.willfail = {
    type: "generic-cli",
    label: "Invalid-model fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [notFoundFixture],
    model: "bad-model",
    models: [{ id: "bad-model", name: "bad-model" }],
    timeoutMs: 10000
  };
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });

  // Seed the catalog with one model per fixture provider (validate-all only
  // walks models already present in the catalog).
  await fetch(`${BASE}/api/model-catalog/providers/good/models/good-model/validate`, { method: "POST", headers: authHeaders() });
  await fetch(`${BASE}/api/model-catalog/providers/willfail/models/bad-model/validate`, { method: "POST", headers: authHeaders() });
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

test("POST /api/model-catalog/validate-all probes every seeded model and does not abort on a failure", async () => {
  const res = await fetch(`${BASE}/api/model-catalog/validate-all`, { method: "POST", headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 2);
  assert.equal(body.validated, 1);
  assert.equal(body.stillUnvalidated, 1);

  const good = body.results.find((r) => r.provider === "good");
  const bad = body.results.find((r) => r.provider === "willfail");
  assert.equal(good.success, true);
  assert.equal(good.state, "validated");
  assert.equal(bad.success, false);
  assert.equal(bad.classification, "MODEL_NOT_FOUND");
  assert.notEqual(bad.state, "validated", "a model that fails validation must stay unvalidated, not silently pass");

  const registryRes = await fetch(`${BASE}/api/routing/registry`, { headers: authHeaders() });
  const registry = (await registryRes.json()).registry;
  const goodEntry = registry.find((e) => e.provider === "good" && e.model === "good-model");
  const badEntry = registry.find((e) => e.provider === "willfail" && e.model === "bad-model");
  assert.equal(goodEntry.automaticEligibility, true);
  assert.equal(badEntry, undefined, "an unvalidated model must not appear in the routing registry at all");
});

test("POST /api/model-catalog/validate-all rejects a concurrent call with 409 while one is already running", async () => {
  const first = fetch(`${BASE}/api/model-catalog/validate-all`, { method: "POST", headers: authHeaders() });
  await new Promise((r) => setTimeout(r, 10));
  const second = await fetch(`${BASE}/api/model-catalog/validate-all`, { method: "POST", headers: authHeaders() });
  assert.equal(second.status, 409);
  await first;
});
