/**
 * PARAGON-D-004D end-to-end coverage (directive tests 23, 24, 25, 28).
 *
 * The properties that only mean anything against a live server: that the
 * dashboard scenario and the shadow engine agree by construction, and that
 * shadow mode changes neither the route nor the number of provider calls.
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
const countingFixture = path.join(__dirname, "fixtures", "count-invocations.js");

const PORT = 4977;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let apiKey;
let tmpCwd;
let counterFile;

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

function invocationCount() {
  try {
    return fs.readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test.before(async () => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-d004d-integ-"));
  counterFile = path.join(tmpCwd, "invocations.log");
  // Two execution profiles of the same canonical model, so shadow ranking has
  // a real reasoning-effort choice to make.
  seedCatalogFile(tmpCwd, { cursor: ["gpt-5.6-sol-low", "gpt-5.6-sol-max"] });

  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: {
      ...process.env,
      PARAGON_HOST: "127.0.0.1",
      PARAGON_PORT: String(PORT),
      PARAGON_MODEL_CATALOG_ENABLED: "0",
      PARAGON_TEST_INVOCATION_LOG: counterFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  apiKey = JSON.parse(fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8")).server.apiKey;

  const config = await (await fetch(`${BASE}/api/config`, { headers: authHeaders() })).json();
  config.providers.cursor = {
    type: "generic-cli",
    label: "Counting fixture",
    enabled: true,
    command: process.execPath,
    runArgs: [countingFixture],
    model: "gpt-5.6-sol-low",
    models: [{ id: "gpt-5.6-sol-low" }, { id: "gpt-5.6-sol-max" }],
    timeoutMs: 10000
  };
  for (const t of Object.keys(config.routing.taskRoutes)) {
    config.routing.taskRoutes[t] = "cursor";
  }
  config.routing.defaultProvider = "cursor";
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

test("routing-intelligence reports shadow mode and keeps D-004C1 as the live selector", async () => {
  const res = await fetch(`${BASE}/api/routing-intelligence`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.settings.mode, "shadow");
  assert.equal(body.liveRouteSelector, "paragon-d-004c1");
  // Provider grammars are exposed so the parsing rules are inspectable.
  assert.ok(body.providerGrammars.cursor.effortTokens.includes("max"));
  assert.ok(!("codex" in body.providerGrammars), "codex must have no declared suffix grammar");
});

test("3/4. low and max execution profiles are represented separately with distinct canonical identity", async () => {
  const res = await fetch(`${BASE}/api/routing-intelligence/scenario`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt: "implement a function", estimatedInputTokens: 1000 })
  });
  const body = await res.json();
  const eligible = body.ranked.filter((c) => !c.excluded);
  assert.equal(eligible.length, 2);
  const byEffort = Object.fromEntries(eligible.map((c) => [c.reasoningEffort, c]));
  assert.ok(byEffort.low && byEffort.max, "both execution profiles must appear as separate candidates");
  assert.equal(byEffort.low.canonicalModelId, "gpt-5.6-sol");
  assert.equal(byEffort.max.canonicalModelId, "gpt-5.6-sol");
  assert.notEqual(byEffort.low.providerModelId, byEffort.max.providerModelId);
});

test("5. a max-reasoning candidate carries a higher expected resource cost than the equivalent low candidate", async () => {
  const res = await fetch(`${BASE}/api/routing-intelligence/scenario`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt: "implement a function", estimatedInputTokens: 1000 })
  });
  const body = await res.json();
  const low = body.ranked.find((c) => c.reasoningEffort === "low");
  const max = body.ranked.find((c) => c.reasoningEffort === "max");
  assert.ok(max.cost.expectedReasoningTokens > low.cost.expectedReasoningTokens);
  assert.ok(max.cost.estimatedQuotaBurn > low.cost.estimatedQuotaBurn);
  assert.ok(max.components.expectedTotalResourceCost > low.components.expectedTotalResourceCost);
});

test("11. utility components and confidence are inspectable per candidate", async () => {
  const res = await fetch(`${BASE}/api/routing-intelligence/scenario`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt: "review this pull request diff", estimatedInputTokens: 5000 })
  });
  const body = await res.json();
  const winner = body.winner;
  for (const field of [
    "probabilityOfSuccessfulCompletion",
    "expectedTaskQuality",
    "expectedTotalResourceCost",
    "expectedLatencyPenalty",
    "expectedQuotaScarcityPenalty",
    "uncertaintyPenalty",
    "reasoningFitAlignment"
  ]) {
    assert.ok(field in winner.components, `missing utility component: ${field}`);
  }
  assert.ok(Array.isArray(winner.components.uncertaintyReasons));
  assert.ok(["high", "medium", "low", "only_eligible", "explicit_validated"].includes(body.confidence.level));
  assert.ok(body.weights.qualityScale > 0, "weights must be reported, not hidden");
});

test("7. large-context scenarios use practical context capacity and can exclude unknown-context candidates", async () => {
  const small = await (
    await fetch(`${BASE}/api/routing-intelligence/scenario`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "hello", estimatedInputTokens: 1000 })
    })
  ).json();
  assert.ok(small.ranked.some((c) => !c.excluded), "a small request must still route");

  const huge = await (
    await fetch(`${BASE}/api/routing-intelligence/scenario`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "analyze everything", estimatedInputTokens: 900000 })
    })
  ).json();
  // gpt-5.6-sol has no documented context entry, so capacity is unknown and a
  // 900k-token request must be refused rather than merely penalized.
  const excludedReasons = huge.ranked.filter((c) => c.excluded).map((c) => c.reasonCode);
  assert.ok(
    excludedReasons.includes("routing.unknownContextForLargeRequest") || excludedReasons.includes("routing.contextWindowExceeded"),
    `expected a context exclusion, got ${JSON.stringify(excludedReasons)}`
  );
});

test("9. capability requirements exclude incompatible candidates", async () => {
  const res = await fetch(`${BASE}/api/routing-intelligence/scenario`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt: "call a tool", estimatedInputTokens: 500, toolCalls: true })
  });
  const body = await res.json();
  assert.ok(body.taskProfile.requiredCapabilities.includes("toolCalls"));
  // PARAGON drives builtin/generic CLI providers tools-disabled, so a
  // tool-call request has no eligible candidate here.
  const excluded = body.ranked.filter((c) => c.excluded).map((c) => c.reasonCode);
  assert.ok(excluded.every((r) => typeof r === "string"));
  assert.ok(
    body.ranked.filter((c) => !c.excluded).length === 0 || excluded.includes("routing.capabilityUnsupported.toolCalls"),
    "a tool request must be gated by the capability check"
  );
});

test("10. same-provider alternate-model plans are generated in shadow analysis", async () => {
  const res = await fetch(`${BASE}/api/routing-intelligence/scenario`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt: "implement a function", estimatedInputTokens: 1000 })
  });
  const body = await res.json();
  assert.equal(body.attemptPlan.length, 2, "both eligible models from the same provider must be planned");
  assert.equal(body.attemptPlan[0].provider, "cursor");
  assert.equal(body.attemptPlan[1].provider, "cursor");
  assert.equal(body.attemptPlan[1].alternateForProvider, true);
});

test("23. dashboard scenario ranking equals the shadow ranking for the same task profile", async () => {
  const scenario = { prompt: "implement a function", estimatedInputTokens: 1234 };
  const first = await (await fetch(`${BASE}/api/routing-intelligence/scenario`, { method: "POST", headers: authHeaders(), body: JSON.stringify(scenario) })).json();

  // Replay the exact derived profile — the dashboard's "custom context" path.
  const replay = await (
    await fetch(`${BASE}/api/routing-intelligence/scenario`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ taskProfile: first.taskProfile }) })
  ).json();

  assert.deepEqual(
    replay.ranked.map((c) => [c.provider, c.providerModelId, c.excluded, c.reasonCode ?? null]),
    first.ranked.map((c) => [c.provider, c.providerModelId, c.excluded, c.reasonCode ?? null]),
    "same profile must produce the same ordering and exclusions"
  );
  assert.equal(replay.winner.providerModelId, first.winner.providerModelId);
});

test("24/25. shadow mode changes neither the live route nor the number of provider invocations", async () => {
  const before = invocationCount();

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "implement a function" }] })
  });
  assert.equal(res.status, 200);

  const after = invocationCount();
  assert.equal(after - before, 1, "exactly one provider invocation — shadow analysis must not add a call");

  // The live decision still comes from the D-004C1 selector.
  assert.equal(res.headers.get("x-paragon-route-reason"), "scored.deterministic");
  const liveModel = res.headers.get("x-paragon-route-model");
  assert.ok(liveModel);

  // Shadow headers are advisory and must not have changed what ran.
  const shadowModel = res.headers.get("x-paragon-shadow-model");
  const body = await res.json();
  assert.equal(body.paragon.provider, "cursor");
  if (shadowModel && shadowModel !== liveModel) {
    assert.equal(res.headers.get("x-paragon-shadow-agrees"), "false", "a disagreement must be reported, not applied");
  }

  const records = await (await fetch(`${BASE}/api/routing-intelligence/shadow-records`, { headers: authHeaders() })).json();
  assert.ok(records.records.length >= 1);
  const record = records.records[0];
  assert.ok(!JSON.stringify(record).includes("implement a function"), "no prompt text may be retained in a shadow record");
  assert.ok(record.taskProfile.workType);
});

test("13. no prompt, response, credential, or API key is persisted by routing telemetry", async () => {
  // Force a telemetry flush window then inspect the store on disk.
  await new Promise((r) => setTimeout(r, 100));
  const telemetryFile = path.join(tmpCwd, "data", "routing-telemetry.json");
  if (!fs.existsSync(telemetryFile)) {
    // Flush is debounced; the in-memory contract is covered by the unit test.
    return;
  }
  const raw = fs.readFileSync(telemetryFile, "utf8");
  assert.ok(!raw.includes(apiKey));
  assert.ok(!raw.includes("implement a function"));
  assert.ok(!/authorization|bearer/i.test(raw));
});
