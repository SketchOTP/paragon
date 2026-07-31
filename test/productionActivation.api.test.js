/**
 * PARAGON-D-004E — production activation, at the HTTP boundary.
 *
 * Runs a real server against real fixture providers and proves the activation
 * contract end to end: one engine, one routing computation, one provider call
 * per attempt, honest usage evidence, classified fallback, and a product-shaped
 * dashboard payload. Nothing here mocks the routing path.
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
const countFixture = path.join(__dirname, "fixtures", "count-invocations.js");
const usageFixture = path.join(__dirname, "fixtures", "echo-usage-json.js");
const quotaFixture = path.join(__dirname, "fixtures", "echo-quota-exhausted.js");
const modelNotFoundFixture = path.join(__dirname, "fixtures", "echo-model-not-found.js");

const PORT = 4956;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let apiKey;
let tmpCwd;
let invocationLog;

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
    return fs.readFileSync(invocationLog, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function cliProvider(label, fixture, extra = {}) {
  return {
    type: "generic-cli",
    label,
    enabled: true,
    command: process.execPath,
    runArgs: [fixture],
    models: [],
    timeoutMs: 15000,
    ...extra
  };
}

test.before(async () => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-activation-integ-"));
  invocationLog = path.join(tmpCwd, "invocations.log");

  // Fixture providers need a real catalog bucket to be routable — config alone
  // is never trusted. `quotap` gets two models so provider-wide skipping can be
  // distinguished from same-provider advancement.
  seedCatalogFile(tmpCwd, {
    counterp: ["fixture-model"],
    usagep: ["usage-model"],
    quotap: ["quota-model-a", "quota-model-b"],
    twomodelp: ["missing-model", "present-model"]
  });

  server = spawn(process.execPath, [path.join(repoRoot, "src/server.js")], {
    cwd: tmpCwd,
    env: {
      ...process.env,
      PARAGON_HOST: "127.0.0.1",
      PARAGON_PORT: String(PORT),
      PARAGON_MODEL_CATALOG_ENABLED: "0",
      PARAGON_TEST_INVOCATION_LOG: invocationLog
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer();
  apiKey = JSON.parse(fs.readFileSync(path.join(tmpCwd, "data", "config.json"), "utf8")).server.apiKey;

  const config = await (await fetch(`${BASE}/api/config`, { headers: authHeaders() })).json();
  // Disable the builtin providers so only the fixtures are candidates.
  for (const name of Object.keys(config.providers)) {
    config.providers[name].enabled = false;
  }
  config.providers.counterp = cliProvider("Counter fixture", countFixture);
  config.providers.usagep = cliProvider("Usage fixture", usageFixture, { structuredOutput: true });
  config.providers.quotap = cliProvider("Quota fixture", quotaFixture);
  config.providers.twomodelp = cliProvider("Two-model fixture", modelNotFoundFixture);
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });
});

test.after(() => {
  server?.kill();
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

/** Restricts routing to one fixture provider by disabling the others. */
async function onlyProvider(name) {
  const config = await (await fetch(`${BASE}/api/config`, { headers: authHeaders() })).json();
  for (const provider of ["counterp", "usagep", "quotap", "twomodelp"]) {
    config.providers[provider].enabled = provider === name;
  }
  await fetch(`${BASE}/api/config`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(config) });
}

// ============================================================================

test("34/6/37. a normal request completes with exactly one routing computation and one provider call", async () => {
  await onlyProvider("counterp");
  const before = invocationCount();

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello" }] })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.paragon.provider, "counterp");
  assert.equal(body.paragon.fallback, false);

  assert.equal(invocationCount(), before + 1, "exactly one provider invocation per request — no duplicate execution");
  assert.equal(res.headers.get("x-paragon-route-reason"), "automatic.expectedUtility");
  assert.equal(res.headers.get("x-paragon-routing-priority"), "balanced");
});

test("4. no shadow header is emitted on a real response", async () => {
  await onlyProvider("counterp");
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hello again" }] })
  });
  await res.json();
  for (const [name] of res.headers) {
    assert.ok(!/shadow/i.test(name), `unexpected shadow header: ${name}`);
  }
  assert.equal(res.headers.get("x-paragon-shadow-provider"), null);
  assert.equal(res.headers.get("x-paragon-shadow-agrees"), null);
});

test("5. no shadow record or shadow endpoint exists on the running server", async () => {
  for (const endpoint of ["/api/routing-intelligence", "/api/routing-intelligence/shadow-records", "/api/routing/status"]) {
    const res = await fetch(`${BASE}${endpoint}`, { headers: authHeaders() });
    // The static handler serves the dashboard for unknown paths; the important
    // thing is that no JSON shadow payload is returned.
    const text = await res.text();
    assert.ok(!text.includes("shadowRouter"), `${endpoint} must not return shadow state`);
    assert.ok(!text.includes("shadowSummary"), `${endpoint} must not return shadow state`);
  }
  // And nothing shadow-shaped is persisted alongside the other data files.
  const files = fs.readdirSync(path.join(tmpCwd, "data"));
  assert.ok(!files.some((f) => /shadow/i.test(f)), `no shadow store may be persisted: ${files.join(", ")}`);
});

test("9. real CLI usage reaches the response and the telemetry store, unwrapped", async () => {
  await onlyProvider("usagep");
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "report usage" }] })
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  // The JSON envelope is unwrapped: the caller gets prose.
  assert.equal(body.choices[0].message.content, "structured fixture answer");
  // And the usage the provider reported is surfaced honestly.
  assert.equal(body.usage.prompt_tokens, 100, "cache-creation input counts as billed input");
  assert.equal(body.usage.completion_tokens, 25);
  assert.equal(body.usage.total_tokens, 125);
  assert.equal(body.usage.paragon_usage_source, "provider_cli_structured");
  assert.equal(body.usage.paragon_usage_confidence, "high");

  const diag = await (await fetch(`${BASE}/api/diagnostics/requests`, { headers: authHeaders() })).json();
  const entry = Object.entries(diag.telemetry.entries).find(([key]) => key.startsWith("usagep|"));
  assert.ok(entry, "the observation must be recorded");
  assert.equal(entry[1].observedTotalBilledTokens, 125);
  assert.equal(entry[1].usageSource, "provider_cli_structured");
});

test("10. a provider that reports no usage records nulls, not zeros", async () => {
  await onlyProvider("counterp");
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "no usage here" }] })
  });
  const body = await res.json();
  assert.equal(body.usage.paragon_usage_source, "unknown");
  // Reasoning is genuinely unknown, so the OpenAI detail block is omitted
  // entirely rather than reported as zero reasoning.
  assert.equal(body.usage.completion_tokens_details, undefined);

  const diag = await (await fetch(`${BASE}/api/diagnostics/requests`, { headers: authHeaders() })).json();
  const entry = Object.entries(diag.telemetry.entries).find(([key]) => key.startsWith("counterp|"));
  assert.equal(entry[1].observedInputTokens, null, "absent usage must never be averaged in as zero");
  assert.equal(entry[1].observedReasoningTokens, null);
  assert.ok(entry[1].usageUnknownCount >= 1);
});

test("35. same-provider fallback advances to another model from the same provider", async () => {
  await onlyProvider("twomodelp");
  // Both models route to the same fixture, which always reports the model as
  // missing — so the plan must try the provider's *second* model rather than
  // abandoning the provider on the first model-specific rejection.
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "try both models" }] })
  });
  // Every model fails, so the request fails — but the *attempt pattern* is the
  // contract under test.
  assert.equal(res.status, 500);
  await res.json();

  const diag = await (await fetch(`${BASE}/api/diagnostics/requests`, { headers: authHeaders() })).json();
  const messages = diag.logs.filter((l) => l.type === "fallback").map((l) => l.message);
  assert.ok(
    messages.some((m) => /condemns only twomodelp\/[a-z-]+; another eligible model from the same provider remains/.test(m)),
    `expected a same-provider advance, got: ${messages.join(" | ")}`
  );
});

test("36. a provider-wide usage-limit failure skips that provider's remaining attempts", async () => {
  // Both quotap models are eligible, but the first failure is provider-wide, so
  // the second model must never be attempted.
  await onlyProvider("quotap");
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "hit the limit" }] })
  });
  assert.equal(res.status, 500);
  await res.json();

  const diag = await (await fetch(`${BASE}/api/diagnostics/requests`, { headers: authHeaders() })).json();
  const skipped = diag.logs.find((l) => /provider-wide; skipping all remaining quotap/.test(l.message ?? ""));
  assert.ok(skipped, "a provider-wide failure must abandon the whole provider");

  // And the exhaustion is now durable state with the provider's own reset date.
  const system = await (await fetch(`${BASE}/api/diagnostics/system`, { headers: authHeaders() })).json();
  assert.ok(system.quotaState.quotap, "the exhausted provider must be recorded");
  assert.equal(system.quotaState.quotap.resetSource, "provider_calendar_date", "the provider's own date must be parsed");
  // The parsed instant is clamped: a provider (or a misparse) must not be able
  // to exile itself for years. The fixture reports 2099, so the stored reset is
  // the bound, which is still comfortably beyond any real monthly cycle.
  const resetAt = Date.parse(system.quotaState.quotap.resetAt);
  assert.ok(resetAt > Date.now(), "the exclusion must be in the future");
  assert.ok(resetAt <= Date.now() + 41 * 24 * 3_600_000, "an implausible reset date must be clamped");
});

test("36b. an exhausted provider is excluded from the next request entirely", async () => {
  await onlyProvider("quotap");
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "again" }] })
  });
  // Nothing is eligible any more, so this is a bounded 503 rather than another
  // doomed provider call.
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, "no_eligible_model");
});

test("a usage-limited model leaves the ranking, says when it returns, and names the reset in activity", async () => {
  // quotap has already hit its limit in the tests above.
  const ranking = await (await fetch(`${BASE}/api/models/ranking`, { headers: authHeaders() })).json();
  const limited = ranking.rows.filter((r) => r.provider === "quotap");
  assert.ok(limited.length, "the model must still be listed, not hidden");
  for (const row of limited) {
    assert.equal(row.routable, false, "a spent allowance must remove it from routing");
    assert.ok(row.availableAgainAt, "and the row must say when it comes back");
    assert.ok(Date.parse(row.availableAgainAt) > Date.now());
  }

  // The product's activity language names the reset, because "unavailable" is
  // far less useful than "unavailable until".
  const activity = await (await fetch(`${BASE}/api/activity`, { headers: authHeaders() })).json();
  const mentioned = activity.activity.find((e) => /quotap/.test(e.failureReason ?? e.recoveredFromReason ?? ""));
  assert.ok(mentioned, "the usage limit must appear in Recent Activity");
  assert.match(
    mentioned.failureReason ?? mentioned.recoveredFromReason,
    /resets (on|at) /,
    "the reason must name the reset, not just the limit"
  );

  // Every row carries the same shape, whatever branch produced it — including
  // the providers that were never assessed.
  const keys = new Set(ranking.rows.map((r) => JSON.stringify(Object.keys(r).sort())));
  assert.equal(keys.size, 1, "every ranking row must have an identical shape");
});

test("13. planned, failed and executed provider-models stay distinct on the dashboard payload", async () => {
  await onlyProvider("counterp");
  await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: "distinct states" }] })
  }).then((r) => r.json());

  const overview = await (await fetch(`${BASE}/api/overview`, { headers: authHeaders() })).json();
  const counter = overview.providers.find((p) => p.provider === "counterp");
  const quota = overview.providers.find((p) => p.provider === "quotap");

  assert.equal(counter.lastUsed.model, "fixture-model", "the executor is reported as last used");
  // The quota fixture failed earlier and was never a successful executor.
  assert.equal(quota.lastUsed, null, "a failed provider must not be reported as having been used");
  assert.ok(quota.lastFailure, "its failure is reported separately");

  // The plan is recorded as a decision, distinct from execution.
  const routing = await (await fetch(`${BASE}/api/diagnostics/routing`, { headers: authHeaders() })).json();
  assert.ok(routing.latestPlan, "the latest attempt plan must be inspectable");
  assert.equal(routing.engine.enginesRunningPerRequest, 1);
});

test("23/34b. the product overview exposes exactly the four areas and no engine internals", async () => {
  const overview = await (await fetch(`${BASE}/api/overview`, { headers: authHeaders() })).json();
  for (const key of ["connection", "providers", "routing", "activity"]) {
    assert.ok(key in overview, `the overview must carry ${key}`);
  }
  const serialized = JSON.stringify(overview);
  for (const pattern of ["shadow", "taskRoutes", "defaultProvider", "fallbackChain", "d-004"]) {
    assert.ok(!new RegExp(pattern, "i").test(serialized), `the product payload must not expose ${pattern}`);
  }
  // Routing is described in product terms.
  assert.equal(overview.routing.priority, "balanced");
  assert.equal(overview.routing.priorityLabel, "Balanced");
});

test("38. no prompt or response content is persisted by routing telemetry on disk", async () => {
  await onlyProvider("counterp");
  const secret = "zebra-cardamom-lighthouse-4417";
  await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "paragon", messages: [{ role: "user", content: secret }] })
  }).then((r) => r.json());

  // Force a flush by waiting for the debounced writer, then inspect the file.
  await new Promise((r) => setTimeout(r, 200));
  const diag = await (await fetch(`${BASE}/api/diagnostics/requests`, { headers: authHeaders() })).json();
  assert.ok(!JSON.stringify(diag.telemetry).includes(secret), "telemetry must not carry prompt text");

  const catalogRaw = fs.readFileSync(path.join(tmpCwd, "data", "model-catalog.json"), "utf8");
  assert.ok(!catalogRaw.includes(secret));
  assert.ok(!catalogRaw.includes(apiKey));
});

test("17/18. the routing priority is settable through the one settings surface and changes the resolved weights", async () => {
  const before = await (await fetch(`${BASE}/api/settings`, { headers: authHeaders() })).json();
  assert.equal(before.routing.priority, "balanced", "Balanced is the default");
  assert.equal(before.routing.options.length, 4);
  assert.deepEqual(before.routing.providerPreferencePoints, {
    codex: 0,
    claude: 0,
    antigravity: 0,
    cursor: 0,
    openrouter: 0,
    lmstudio: 0
  });
  assert.equal(before.routing.providerPreferenceScale, 3);

  const pointsSaved = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ routing: { providerPreferencePoints: { codex: 4.5, claude: 1.5 }, providerPreferenceScale: 4 } })
  });
  assert.equal(pointsSaved.status, 200);
  assert.equal((await pointsSaved.json()).settings.routing.providerPreferencePoints.codex, 4.5);
  assert.equal((await (await fetch(`${BASE}/api/settings`, { headers: authHeaders() })).json()).routing.providerPreferenceScale, 4);

  const saved = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ routing: { priority: "cost" } })
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.routing.priority, "cost");

  const routing = await (await fetch(`${BASE}/api/diagnostics/routing`, { headers: authHeaders() })).json();
  assert.equal(routing.priority.priority, "cost");
  assert.ok(
    routing.priority.resolvedWeights.resourceCostScale > routing.priority.baselineWeights.resourceCostScale,
    "the preset must transparently change the cost weight"
  );

  // An invalid value is rejected rather than silently coerced.
  const bad = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ routing: { priority: "turbo" } })
  });
  assert.equal(bad.status, 400);

  // Restore the defaults for any later test.
  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ routing: { priority: "balanced" } })
  });
  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ routing: { providerPreferencePoints: { codex: 3, claude: 2 }, providerPreferenceScale: 3 } })
  });
});

test("saving one settings category preserves every unrelated configuration value", async () => {
  const before = await (await fetch(`${BASE}/api/config`, { headers: authHeaders() })).json();

  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ routing: { priority: "speed" } })
  });

  const after = await (await fetch(`${BASE}/api/config`, { headers: authHeaders() })).json();
  assert.equal(after.routing.priority, "speed");
  // Credentials, provider state and connectivity are untouched.
  assert.equal(after.server.apiKey, before.server.apiKey);
  assert.equal(after.server.tailscaleHost, before.server.tailscaleHost);
  assert.equal(after.server.exposedModel, before.server.exposedModel);
  assert.deepEqual(Object.keys(after.providers).sort(), Object.keys(before.providers).sort());
  for (const name of Object.keys(before.providers)) {
    assert.equal(after.providers[name].enabled, before.providers[name].enabled, `${name} enablement preserved`);
    assert.equal(after.providers[name].command, before.providers[name].command);
    assert.equal(after.providers[name].avatar, before.providers[name].avatar);
  }
  assert.equal(after.integrations.openrouterApiKey, before.integrations.openrouterApiKey);

  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ routing: { priority: "balanced" } })
  });
});

test("the combined Model Ranking lists every known model, ranks the routable ones, and explains the rest", async () => {
  await onlyProvider("counterp");
  const body = await (await fetch(`${BASE}/api/models/ranking`, { headers: authHeaders() })).json();

  // Every model PARAGON knows about is present — not just the routable ones.
  assert.ok(body.totals.models >= body.totals.routable);
  assert.equal(body.totals.models, body.rows.length);
  assert.ok(body.rows.some((r) => r.provider === "counterp" && r.routable), "the enabled provider's model must be routable");
  assert.ok(body.rows.some((r) => r.provider === "quotap" && !r.routable), "a disabled provider's models must still be listed");

  // A rank is only meaningful relative to a kind of work, and the response says
  // which — plus the priority the ranking was computed under.
  assert.ok(body.rankedFor.workType);
  assert.ok(body.rankedFor.complexity);
  assert.equal(body.priority.priority, "balanced");

  const ranked = body.rows.filter((r) => r.routable);
  assert.ok(ranked.length >= 1);
  // Routable rows come first, in rank order.
  assert.deepEqual(
    ranked.map((r) => r.rank),
    [...ranked.map((r) => r.rank)].sort((a, b) => a - b)
  );

  const top = ranked[0];
  // The catalog facts and the ranking factors live on the same row — this is
  // the whole point of merging the two retired panels.
  assert.equal(top.state, "validated");
  assert.equal(top.validated, true);
  assert.ok(top.expectedUtility != null);
  assert.ok(top.quality && top.quality.source, "quality must carry its evidence source");
  assert.ok(top.cost && top.cost.reasoningEstimateSource, "cost must carry its reasoning evidence source");
  assert.ok(top.reasoningEffort, "the level of thinking must be reported");
  assert.ok(top.telemetry, "observed evidence must be reported");
  assert.ok("measuredEvidenceShare" in top);
  // The head of the plan is identifiable, so the table agrees with what would
  // actually be attempted.
  assert.equal(top.attemptOrder, 1);

  // Every non-routable row states *why*, specifically.
  for (const row of body.rows.filter((r) => !r.routable)) {
    assert.ok(row.excludedBecause, `${row.provider}/${row.model} must say why it cannot route`);
    assert.notEqual(row.excludedBecause, "eligibility.notACandidate", "the reason must be specific, not a placeholder");
  }
});

test("the Model Ranking reflects the kind of work it was asked about", async () => {
  await onlyProvider("counterp");
  const trivial = await (await fetch(`${BASE}/api/models/ranking?workType=quick&complexity=trivial`, { headers: authHeaders() })).json();
  const extreme = await (await fetch(`${BASE}/api/models/ranking?workType=architecture&complexity=extreme`, { headers: authHeaders() })).json();

  assert.equal(trivial.rankedFor.complexity, "trivial");
  assert.equal(extreme.rankedFor.complexity, "extreme");
  assert.equal(trivial.rankedFor.estimatedRequiredContextTokens, 4000);
  assert.equal(extreme.rankedFor.estimatedRequiredContextTokens, 300000);
  // The same model is scored differently for different work, which is why the
  // table states what it ranked for rather than implying one absolute order.
  const t = trivial.rows.find((r) => r.routable);
  const e = extreme.rows.find((r) => r.routable);
  assert.ok(t && e);
  assert.notEqual(t.expectedUtility, e.expectedUtility);
});

test("21. /v1/models remains stable and OpenAI-compatible", async () => {
  const res = await fetch(`${BASE}/v1/models`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "list");
  assert.ok(body.data.some((m) => m.id === "paragon"));
  assert.ok(body.data.every((m) => m.object === "model" && m.owned_by === "paragon"));
});
