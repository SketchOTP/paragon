/**
 * PARAGON-D-004C1 routing-integrity regressions at the HTTP boundary.
 *
 * Covers the directive cases that are only meaningful end-to-end: the 503
 * `no_eligible_model` response that replaced the static fallback, startup
 * config reconciliation, and the absence of any config-derived dispatch.
 */

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

const PORT = 4971;
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
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-integrity-integ-"));

  // A catalog where the only assessed provider's model has been rejected,
  // and a stale configured model is present for it — so startup
  // reconciliation has something real to clean up.
  const catalog = seedCatalogFile(tmpCwd, { deadp: ["dead-model"] });
  catalog.providers.deadp.models["dead-model"].state = "rejected";
  catalog.providers.deadp.models["dead-model"].automaticEligibility = false;
  fs.writeFileSync(path.join(tmpCwd, "data", "model-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  // Pre-write a config naming that rejected model, mimicking a config that
  // went stale before the reconciliation pass existed.
  fs.writeFileSync(
    path.join(tmpCwd, "data", "config.json"),
    `${JSON.stringify(
      {
        server: { host: "127.0.0.1", port: PORT, exposedModel: "paragon", apiKey: "integrity-test-key" },
        providers: {
          deadp: {
            type: "generic-cli",
            label: "Dead provider",
            enabled: true,
            command: process.execPath,
            runArgs: [path.join(__dirname, "fixtures", "echo-json.js")],
            model: "dead-model",
            models: [{ id: "dead-model", name: "dead-model" }],
            timeoutMs: 10000
          }
        },
        routing: { defaultProvider: "deadp", fallbackChain: ["deadp"], taskRoutes: { code: "deadp" } }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: { ...process.env, PARAGON_HOST: "127.0.0.1", PARAGON_PORT: String(PORT), PARAGON_MODEL_CATALOG_ENABLED: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  apiKey = JSON.parse(fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8")).server.apiKey;
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

test("1. an empty eligible registry returns 503 no_eligible_model instead of a static fallback route", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.type, "paragon_routing_error");
  assert.equal(body.error.code, "no_eligible_model");
  assert.equal(res.headers.get("x-paragon-route-reason"), "routing.noEligibleModel");
});

test("1b. no response ever reports the removed fallback.staticDefault reason code", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "review this diff" }] })
  });
  assert.notEqual(res.headers.get("x-paragon-route-reason"), "fallback.staticDefault");
  await res.json().catch(() => {});
});

test("2/5. a configured-but-rejected model is never dispatched, even as a last resort", async () => {
  const logsRes = await fetch(`${BASE}/api/logs`, { headers: authHeaders() });
  const logs = (await logsRes.json()).logs;
  assert.ok(
    !logs.some((l) => l.type === "completion" && l.provider === "deadp"),
    "the rejected model's provider must never have been executed"
  );
});

test("4. startup reconciliation cleared the stale configured model that predated this implementation", async () => {
  const res = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await res.json();
  assert.equal(config.providers.deadp.model, "", "a configured model the catalog rejected must be cleared at startup");

  const logsRes = await fetch(`${BASE}/api/logs`, { headers: authHeaders() });
  const logs = (await logsRes.json()).logs;
  assert.ok(
    logs.some((l) => l.message.includes("routing.configuredModelCleared") && l.message.includes("dead-model")),
    "the cleanup must be recorded in bounded diagnostics"
  );
});

test("4b. the cleared configured model is not replaced with an arbitrary catalog model", async () => {
  const res = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await res.json();
  assert.equal(config.providers.deadp.model, "");
});

test("9. an unassessed provider is reported pending_assessment and contributes nothing routable", async () => {
  const configRes = await fetch(`${BASE}/api/config`, { headers: authHeaders() });
  const config = await configRes.json();
  config.providers.freshp = {
    type: "generic-cli",
    label: "Fresh provider",
    enabled: true,
    command: process.execPath,
    runArgs: [path.join(__dirname, "fixtures", "echo-json.js")],
    model: "never-assessed",
    models: [{ id: "never-assessed", name: "never-assessed" }],
    timeoutMs: 10000
  };
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });

  const regRes = await fetch(`${BASE}/api/routing/registry`, { headers: authHeaders() });
  const { registry } = await regRes.json();
  const rows = registry.filter((e) => e.provider === "freshp");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelState, "pending_assessment");
  assert.equal(rows[0].automaticEligibility, false);
  assert.equal(rows[0].model, null);
  assert.ok(
    !registry.some((e) => e.model === "never-assessed"),
    "a configured model must not become routable without a completed assessment"
  );
});

test("21. the registry endpoint reports benchmark staleness so scoring can be withheld", async () => {
  const res = await fetch(`${BASE}/api/routing/registry`, { headers: authHeaders() });
  const body = await res.json();
  // No OpenRouter key in this sandbox: benchmarks disabled, and never applied.
  assert.equal(body.benchmarks.enabled, false);
  assert.equal(body.benchmarks.applied, false);
  assert.equal(body.benchmarks.stale, true);
  assert.ok("maxUsableAgeMs" in body.benchmarks);
  assert.ok("lastSuccessfulFetchAt" in body.benchmarks);
  assert.ok("lastAttemptAt" in body.benchmarks);
});

test("no prompt, response, API key, or credential is persisted in catalog state", async () => {
  const raw = fs.readFileSync(path.join(tmpCwd, "data", "model-catalog.json"), "utf8");
  assert.ok(!raw.includes("integrity-test-key"));
  assert.ok(!/Reply with exactly one word/i.test(raw));
  assert.ok(!/apiKey|authorization|bearer/i.test(raw));
});
