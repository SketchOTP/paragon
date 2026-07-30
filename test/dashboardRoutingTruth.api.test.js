/**
 * PARAGON-D-004D1 at the HTTP boundary.
 *
 * The claims that only hold end-to-end: that removing the default-provider and
 * fallback-chain controls does not reset those stored values, that validating
 * a single model does not write a configured-model preference, that the new
 * routing-status surfaces report the two engines separately, and that avatar
 * upload stores a file path rather than base64 in config.json.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { seedCatalogFile } from "./helpers/seedCatalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PORT = 4983;
const BASE = `http://127.0.0.1:${PORT}`;

// Distinctive so a reset-to-default would be unmistakable: the defaultConfig
// values are "codex" and ["codex", "cursor"].
const STORED_DEFAULT_PROVIDER = "beta";
const STORED_FALLBACK_CHAIN = ["beta", "alpha"];
const STORED_ALPHA_MODEL = "alpha-one";

let server;
let apiKey;
let tmpCwd;
let configPath;

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

function readStoredConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

test.before(async () => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-d004d1-integ-"));
  configPath = path.join(tmpCwd, "data", "config.json");

  // Two assessed providers with real eligible models, so nothing here is
  // pending-assessment noise and a chat completion can actually route.
  seedCatalogFile(tmpCwd, { alpha: ["alpha-one", "alpha-two"], beta: ["beta-one"] });

  const cliArgs = [path.join(__dirname, "fixtures", "echo-json.js")];
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        server: { host: "127.0.0.1", port: PORT, exposedModel: "paragon", apiKey: "d004d1-test-key" },
        providers: {
          alpha: {
            type: "generic-cli",
            label: "Alpha",
            enabled: true,
            command: process.execPath,
            runArgs: cliArgs,
            model: STORED_ALPHA_MODEL,
            models: [],
            timeoutMs: 10000
          },
          beta: {
            type: "generic-cli",
            label: "Beta",
            enabled: true,
            command: process.execPath,
            runArgs: cliArgs,
            model: "",
            models: [],
            timeoutMs: 10000
          }
        },
        routing: {
          defaultProvider: STORED_DEFAULT_PROVIDER,
          fallbackChain: STORED_FALLBACK_CHAIN,
          taskRoutes: { code: "alpha", debug: "alpha", review: "alpha", plan: "beta", explain: "beta", docs: "beta", quick: "beta" }
        }
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
  apiKey = readStoredConfig().server.apiKey;
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

// --- Phase 8: hidden compatibility fields survive an unrelated save ---------

test("8/9/10. saving an unrelated setting preserves defaultProvider, fallbackChain and providerConfig.model", async () => {
  // Exactly what the dashboard does: GET the whole document, change one
  // unrelated field, PUT it back. The deprecated fields are never touched by
  // the client, so they must round-trip byte-for-value.
  const before = await (await fetch(`${BASE}/api/config`, { headers: authHeaders() })).json();
  assert.equal(before.routing.defaultProvider, STORED_DEFAULT_PROVIDER, "fixture precondition");
  assert.deepEqual(before.routing.fallbackChain, STORED_FALLBACK_CHAIN, "fixture precondition");
  assert.equal(before.providers.alpha.model, STORED_ALPHA_MODEL, "fixture precondition");

  const edited = { ...before, server: { ...before.server, tailscaleHost: "example.tail.ts.net" } };
  const res = await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(edited) });
  assert.equal(res.status, 200);
  const after = await res.json();

  assert.equal(after.server.tailscaleHost, "example.tail.ts.net", "the edit itself must apply");
  assert.equal(after.routing.defaultProvider, STORED_DEFAULT_PROVIDER);
  assert.deepEqual(after.routing.fallbackChain, STORED_FALLBACK_CHAIN);
  assert.equal(after.providers.alpha.model, STORED_ALPHA_MODEL);

  // And on disk, not merely in the response.
  const stored = readStoredConfig();
  assert.equal(stored.routing.defaultProvider, STORED_DEFAULT_PROVIDER);
  assert.deepEqual(stored.routing.fallbackChain, STORED_FALLBACK_CHAIN);
  assert.equal(stored.providers.alpha.model, STORED_ALPHA_MODEL);
});

test("8b. a task-preference change is the only routing field it touches", async () => {
  const before = await (await fetch(`${BASE}/api/config`, { headers: authHeaders() })).json();
  const edited = { ...before, routing: { ...before.routing, taskRoutes: { ...before.routing.taskRoutes, code: "beta" } } };
  const after = await (
    await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(edited) })
  ).json();

  assert.equal(after.routing.taskRoutes.code, "beta");
  assert.equal(after.routing.defaultProvider, STORED_DEFAULT_PROVIDER);
  assert.deepEqual(after.routing.fallbackChain, STORED_FALLBACK_CHAIN);

  // Restore so later assertions see the original preference.
  const restored = { ...after, routing: { ...after.routing, taskRoutes: { ...after.routing.taskRoutes, code: "alpha" } } };
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(restored) });
});

// --- Phase 1: provider summary + model validation ---------------------------

test("2b. the provider summary reports eligible counts and automatic per-request selection", async () => {
  const res = await fetch(`${BASE}/api/routing/providers`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.selection, "automatic-per-request");

  const byId = Object.fromEntries(body.providers.map((p) => [p.provider, p]));
  assert.equal(byId.alpha.counts.eligible, 2);
  assert.equal(byId.beta.counts.eligible, 1);
  assert.equal(byId.alpha.catalogState, "assessed");
  // Counts must match the catalog, which is the same source live routing reads.
  const catalog = await (await fetch(`${BASE}/api/model-catalog`, { headers: authHeaders() })).json();
  const catalogEligible = Object.values(catalog.providers.alpha.models).filter((m) => m.automaticEligibility).length;
  assert.equal(byId.alpha.counts.eligible, catalogEligible);
});

test("4b. validating one model updates catalog state only — it never writes providerConfig.model", async () => {
  const beforeModel = readStoredConfig().providers.beta.model;
  assert.equal(beforeModel, "", "fixture precondition: beta has no configured model");

  const res = await fetch(`${BASE}/api/model-catalog/providers/beta/models/beta-one/validate`, {
    method: "POST",
    headers: authHeaders()
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, "beta-one");
  assert.ok(body.state, "validation must report the resulting catalog state");

  assert.equal(readStoredConfig().providers.beta.model, "", "validation wrote a configured-model preference");
});

// --- Phases 2, 3, 5, 7: routing status -------------------------------------

test("14b/15b/16b. routing status separates the executing live engine from the advisory shadow engine", async () => {
  const res = await fetch(`${BASE}/api/routing/status`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.liveRouter.engine, "paragon-d-004c1");
  assert.equal(body.liveRouter.mode, "live");
  assert.equal(body.liveRouter.decidesExecution, true);
  assert.equal(body.liveRouter.catalogEligibilityEnforced, true);
  assert.equal(body.liveRouter.staticDefaultFallback, false);
  assert.equal(body.liveRouter.emptyEligibleSetBehavior.status, 503);
  assert.equal(body.liveRouter.emptyEligibleSetBehavior.code, "no_eligible_model");
  // The preference weight is reported from the live scorer, not restated.
  assert.equal(typeof body.liveRouter.taskProviderPreferencePoints, "number");
  assert.ok(body.liveRouter.taskProviderPreferencePoints > 0);

  assert.equal(body.shadowRouter.engine, "paragon-d-004d");
  assert.equal(body.shadowRouter.mode, "shadow");
  assert.equal(body.shadowRouter.decidesExecution, false);
  assert.equal(body.shadowRouter.affectsProviderExecution, false);
  assert.equal(body.shadowRouter.additionalProviderCalls, false);
  assert.equal(body.shadowRouter.consumesTaskProviderPreference, false);
});

test("7b/18b. routing status reports the deprecated fields as non-authoritative, and taskRoutes as an active preference", async () => {
  const body = await (await fetch(`${BASE}/api/routing/status`, { headers: authHeaders() })).json();

  const paths = body.deprecatedConfigFields.map((f) => f.path).sort();
  assert.deepEqual(paths, ["providers.*.model", "routing.defaultProvider", "routing.fallbackChain"]);
  for (const field of body.deprecatedConfigFields) {
    assert.equal(field.authoritativeForLiveRouting, false);
    assert.equal(field.retainedForBackwardCompatibility, true);
  }
  assert.deepEqual(body.activePreferenceFields.map((f) => f.path), ["routing.taskRoutes"]);
  assert.equal(body.activePreferenceFields[0].notARoute, true);
});

// --- Phases 3 and 5: observed attempt plans and last-used models ------------

test("17b. after a real request, the live attempt plan and last live model are reported", async () => {
  const chat = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "implement a function" }] })
  });
  assert.equal(chat.status, 200);
  const routedModel = chat.headers.get("x-paragon-route-model");
  assert.ok(routedModel, "the response must report the model actually chosen");
  await chat.json();

  const status = await (await fetch(`${BASE}/api/routing/status`, { headers: authHeaders() })).json();
  const livePlan = status.liveRouter.latestAttemptPlan;
  assert.ok(livePlan, "no live attempt plan recorded after a real request");
  assert.equal(livePlan.engine, "paragon-d-004c1");
  assert.ok(livePlan.plan.length >= 1);
  assert.equal(livePlan.plan[0].model, routedModel, "the recorded plan head must be the model that was dispatched");

  const shadowPlan = status.shadowRouter.latestAttemptPlan;
  assert.ok(shadowPlan, "no shadow attempt plan recorded after a real request");
  assert.equal(shadowPlan.engine, "paragon-d-004d");
  // The shadow plan is derived from the task profile, never the prompt.
  assert.ok(shadowPlan.taskProfile);
  assert.ok(!JSON.stringify(shadowPlan).includes("implement a function"), "the shadow plan record retained prompt text");

  // Per-provider observation lands on the summary the cards render.
  const providers = await (await fetch(`${BASE}/api/routing/providers`, { headers: authHeaders() })).json();
  const observed = providers.providers.filter((p) => p.lastLiveModel);
  assert.ok(observed.length >= 1, "no provider reports a last live model after a real request");
  assert.equal(observed[0].lastLiveModel.model, routedModel);
});

// --- Phase 6: shadow settings ----------------------------------------------

test("6c. shadow settings are writable, validated, and cannot flip the engine live", async () => {
  const ok = await fetch(`${BASE}/api/routing-intelligence/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ quotaScarcity: 0.25, maximumAttempts: 3 })
  });
  assert.equal(ok.status, 200);
  const saved = await ok.json();
  assert.equal(saved.quotaScarcity, 0.25);
  assert.equal(saved.maximumAttempts, 3);
  assert.equal(saved.mode, "shadow", "saving shadow settings must not change the mode");

  const bad = await fetch(`${BASE}/api/routing-intelligence/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ quotaScarcity: 5 })
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.details.join(" "), /quotaScarcity/);

  const activation = await fetch(`${BASE}/api/routing-intelligence/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ mode: "live" })
  });
  assert.equal(activation.status, 400, "the dashboard must not be able to activate D-004D");
  assert.match((await activation.json()).error.details.join(" "), /own directive/);

  // Live routing is unchanged by any of that.
  const status = await (await fetch(`${BASE}/api/routing/status`, { headers: authHeaders() })).json();
  assert.equal(status.liveRouter.engine, "paragon-d-004c1");
  assert.equal(status.shadowRouter.mode, "shadow");
});

// --- Avatars ---------------------------------------------------------------

test("avatar upload stores a served file path, never base64 in config.json", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  const res = await fetch(`${BASE}/api/providers/alpha/avatar`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ dataUrl })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.avatar, /^\/provider-avatars\/alpha\.png\?v=\d+$/);

  const stored = readStoredConfig();
  assert.equal(stored.providers.alpha.avatar, body.avatar);
  assert.ok(!JSON.stringify(stored).includes(png.toString("base64")), "config.json carries base64 image data");
  assert.ok(fs.existsSync(path.join(tmpCwd, "data", "avatars", "alpha.png")), "the avatar file was not written");

  // And it is actually served.
  const served = await fetch(`${BASE}${body.avatar}`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).length, png.length);

  // Uploading an avatar must not disturb the deprecated compatibility fields.
  assert.equal(stored.routing.defaultProvider, STORED_DEFAULT_PROVIDER);
  assert.deepEqual(stored.routing.fallbackChain, STORED_FALLBACK_CHAIN);
  assert.equal(stored.providers.alpha.model, STORED_ALPHA_MODEL);
});

test("avatar upload rejects a non-image payload and an unknown provider", async () => {
  const script = Buffer.from("<script>alert(1)</script>").toString("base64");
  const bad = await fetch(`${BASE}/api/providers/alpha/avatar`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${script}` })
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /PNG, JPEG or WebP/);

  const unknown = await fetch(`${BASE}/api/providers/does-not-exist/avatar`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ dataUrl: "data:image/png;base64,AAAA" })
  });
  assert.equal(unknown.status, 404);
});

test("clearing an avatar removes the file and falls back to the bundled asset", async () => {
  const res = await fetch(`${BASE}/api/providers/alpha/avatar`, { method: "DELETE", headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).avatar, "");
  assert.equal(readStoredConfig().providers.alpha.avatar, "");
  assert.ok(!fs.existsSync(path.join(tmpCwd, "data", "avatars", "alpha.png")));
});
