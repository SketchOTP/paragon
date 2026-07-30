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
  // PARAGON-D-004C1 (P0-2/P0-4): a forced provider must resolve to a
  // catalog-eligible model, and config alone is never trusted.
  seedCatalogFile(tmpCwd, {
    codex: ["codex-test-model"],
    antigravity: ["antigravity-test-model"],
    forceme: ["fixture-model"]
  });
  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: { ...process.env, PARAGON_HOST: "127.0.0.1", PARAGON_PORT: String(PORT), PARAGON_MODEL_CATALOG_ENABLED: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  const raw = fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8");
  apiKey = JSON.parse(raw).server.apiKey;

  // Deterministic provider used for the force-routing assertions.
  const configRes = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await configRes.json();
  config.providers.forceme = {
    type: "generic-cli",
    label: "Force target fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [echoJsonFixture],
    model: "fixture-model",
    models: [{ id: "fixture-model", name: "fixture-model" }],
    timeoutMs: 10000
  };
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });
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
  // Forces the local fixture provider rather than a real CLI. A forced route is
  // health-gated, and provider health here comes from actually probing the
  // installed CLI — under parallel test load that probe can legitimately
  // report unhealthy, which made this assertion flaky for reasons unrelated to
  // the hint being honored.
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "X-Paragon-Force-Provider": "forceme" }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(res.headers.get("x-paragon-route-reason"), "hint.forceProvider");
  assert.equal(res.headers.get("x-paragon-route-model"), "fixture-model");
  const body = await res.json();
  assert.equal(body.paragon.provider, "forceme", "the forced provider must be the one that executed");
});

test("antigravity can be chosen by automatic routing once it has a real candidate model, and forcing it still works too", async () => {
  const configRes = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await configRes.json();
  config.providers.antigravity.enabled = true;
  // A fresh sandbox config has no discovered models for antigravity
  // (models: []), so it would never be a routing candidate regardless of
  // eligibility — give it one so this actually exercises automatic
  // selection, not just "nothing to choose from".
  config.providers.antigravity.models = [{ id: "antigravity-test-model", name: "antigravity-test-model" }];
  config.providers.antigravity.model = "antigravity-test-model";
  // Bias every task route toward antigravity.
  // Automatic routing consumes no provider preference; eligibility comes from
  // the seeded catalog alone.
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "implement a function" }] })
  });
  assert.equal(res.headers.get("x-paragon-route-reason"), "automatic.expectedUtility");
  // Asserts the *routing decision*, not the provider that ultimately
  // answered: the real antigravity CLI is not usable in a hermetic sandbox,
  // so execution correctly falls back to another eligible provider and
  // telemetry's run.provider records whoever succeeded. The route headers
  // are set from the scored decision before any dispatch, which is what
  // this test is actually about.
  assert.equal(
    res.headers.get("x-paragon-route-model"),
    "antigravity-test-model",
    "with a real candidate and every task-route preference biased toward it, automatic routing must select antigravity's model"
  );

  const runId = res.headers.get("x-paragon-run-id");
  await res.json().catch(() => {});

  const runRes = await fetch(`${BASE}/api/orchestration/runs/${runId}`, { headers: authHeaders() });
  const run = await runRes.json();
  assert.ok(run, "the run must still be recorded regardless of which provider answered");

  // PARAGON-D-004C1 (P0-2): forcing is asserted against a fixture provider
  // rather than the real antigravity CLI. The automatic attempt above
  // dispatches to the real CLI, which in a hermetic sandbox fails and — by
  // design — immediately marks that exact model ineligible, so a subsequent
  // forced request for it is correctly denied. Using a provider whose
  // execution outcome is deterministic keeps this assertion about forcing,
  // not about whether a real CLI happened to be usable.
  const forcedRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "X-Paragon-Force-Provider": "forceme" }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(forcedRes.headers.get("x-paragon-route-reason"), "hint.forceProvider");
  assert.equal(forcedRes.status, 200);
});

test("a forced provider whose model the catalog has rejected is denied, not silently downgraded", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "X-Paragon-Force-Provider": "forceme", "X-Paragon-Force-Model": "not-a-real-model" }),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, "paragon_routing_error");
  assert.equal(body.error.code, "routing.forcedModelNotEligible");
  assert.equal(res.headers.get("x-paragon-route-reason"), "routing.forcedModelNotEligible");
});
