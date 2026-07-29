import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTO_ELIGIBLE_STATES,
  applyExecutionResult,
  classifyModelFailure,
  defaultCatalog,
  isEligibleNow,
  listCatalogEntries,
  MODEL_STATES,
  normalizeCatalog,
  replaceProviderModels
} from "../src/modelCatalog.js";

test("MODEL_STATES includes every state the directive requires, and only exposed/validated are auto-eligible", () => {
  for (const state of [
    "exposed",
    "validated",
    "stale",
    "rejected",
    "unavailable",
    "authentication_blocked",
    "quota_blocked",
    "entitlement_blocked",
    "configuration_blocked",
    "provider_offline",
    "unknown",
    "retired"
  ]) {
    assert.ok(MODEL_STATES.includes(state), `missing state: ${state}`);
  }
  assert.deepEqual([...AUTO_ELIGIBLE_STATES].sort(), ["exposed", "validated"]);
});

test("classifyModelFailure recognizes each documented failure category", () => {
  assert.equal(classifyModelFailure(new Error("Model not found: gpt-9")), "MODEL_NOT_FOUND");
  assert.equal(classifyModelFailure(new Error("unsupported model requested")), "MODEL_REJECTED");
  assert.equal(classifyModelFailure(new Error("model is currently unavailable")), "MODEL_UNAVAILABLE");
  assert.equal(classifyModelFailure(new Error("401 unauthorized, not logged in")), "AUTHENTICATION_FAILED");
  assert.equal(classifyModelFailure(new Error("you are out of extra usage · resets in 4h")), "QUOTA_EXHAUSTED");
  assert.equal(classifyModelFailure(new Error("this model requires a subscription upgrade")), "ENTITLEMENT_REQUIRED");
  assert.equal(classifyModelFailure(new Error("429 too many requests")), "RATE_LIMITED");
  assert.equal(classifyModelFailure(new Error("ECONNREFUSED")), "PROVIDER_OFFLINE");
  assert.equal(classifyModelFailure(new Error("baseUrl is required for HTTP providers")), "CONFIGURATION_ERROR");
  assert.equal(classifyModelFailure(new Error("codex timed out after 30000ms")), "TIMEOUT");
  assert.equal(classifyModelFailure(new Error("something odd happened")), "TRANSIENT_FAILURE");
  assert.equal(classifyModelFailure(null), "TRANSIENT_FAILURE");
});

test("normalizeCatalog defends against a corrupt/hand-edited catalog file", () => {
  assert.deepEqual(normalizeCatalog(null), defaultCatalog());
  assert.deepEqual(normalizeCatalog("not an object"), defaultCatalog());
  assert.deepEqual(normalizeCatalog([1, 2, 3]), defaultCatalog());
  const partial = normalizeCatalog({ generation: 5 });
  assert.equal(partial.generation, 5);
  assert.deepEqual(partial.providers, {});
});

test("isEligibleNow: exposed is eligible without a TTL check; validated expires past the TTL", () => {
  const now = Date.now();
  assert.equal(isEligibleNow({ state: "exposed" }, { now }), true);
  assert.equal(isEligibleNow({ state: "validated", validatedAt: new Date(now - 1 * 3_600_000).toISOString() }, { ttlHours: 24, now }), true);
  assert.equal(isEligibleNow({ state: "validated", validatedAt: new Date(now - 25 * 3_600_000).toISOString() }, { ttlHours: 24, now }), false);
  assert.equal(isEligibleNow({ state: "validated", validatedAt: null }, { now }), false, "no validation timestamp means not eligible");
  assert.equal(isEligibleNow({ state: "rejected" }, { now }), false);
  assert.equal(isEligibleNow({ state: "unknown" }, { now }), false);
  assert.equal(isEligibleNow(null, { now }), false);
});

test("replaceProviderModels is an authoritative replacement — a model missing from the new set is retired, not merged forward as still eligible", () => {
  let catalog = defaultCatalog();
  catalog = { ...catalog, generation: 1 };
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" },
    { modelId: "claude-old-model", displayName: "Old", state: "validated", discoverySource: "documented_candidate" }
  ]);
  assert.equal(catalog.providers.claude.models["claude-opus-5"].state, "validated");
  assert.equal(catalog.providers.claude.models["claude-old-model"].state, "validated");

  catalog.generation = 2;
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" }
  ]);

  assert.equal(catalog.providers.claude.models["claude-opus-5"].state, "validated");
  assert.equal(catalog.providers.claude.models["claude-old-model"].state, "retired", "absent from the new authoritative set must be retired, not left validated");
  assert.equal(catalog.providers.claude.models["claude-old-model"].automaticEligibility, false);
});

test("replaceProviderModels never merges a rejected candidate back to eligible on the same call", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "codex", [
    { modelId: "gpt-9", displayName: "gpt-9", state: "rejected", discoverySource: "binary_candidate" }
  ]);
  assert.equal(catalog.providers.codex.models["gpt-9"].automaticEligibility, false);
});

test("applyExecutionResult: a successful run marks the model validated and immediately eligible", () => {
  const catalog = defaultCatalog();
  applyExecutionResult(catalog, "cursor", "composer-2.5", { success: true });
  const entry = catalog.providers.cursor.models["composer-2.5"];
  assert.equal(entry.state, "validated");
  assert.equal(entry.automaticEligibility, true);
  assert.ok(entry.validatedAt);
  assert.ok(entry.lastSuccessAt);
});

test("applyExecutionResult: a hard failure (e.g. MODEL_NOT_FOUND) immediately excludes the model from automatic eligibility", () => {
  const catalog = defaultCatalog();
  applyExecutionResult(catalog, "cursor", "composer-2.5", { success: true });
  applyExecutionResult(catalog, "cursor", "composer-2.5", { success: false, classification: "MODEL_NOT_FOUND" });
  const entry = catalog.providers.cursor.models["composer-2.5"];
  assert.equal(entry.state, "rejected");
  assert.equal(entry.automaticEligibility, false);
  assert.equal(entry.lastFailureClassification, "MODEL_NOT_FOUND");
});

test("applyExecutionResult: a transient failure (RATE_LIMITED/TIMEOUT) is recorded but does not demote an eligible model's state", () => {
  const catalog = defaultCatalog();
  applyExecutionResult(catalog, "cursor", "composer-2.5", { success: true });
  applyExecutionResult(catalog, "cursor", "composer-2.5", { success: false, classification: "RATE_LIMITED" });
  const entry = catalog.providers.cursor.models["composer-2.5"];
  assert.equal(entry.state, "validated", "transient failures must not fabricate a hard-rejected state off one blip");
  assert.equal(entry.automaticEligibility, true);
  assert.equal(entry.lastFailureClassification, "RATE_LIMITED");
});

test("each documented failure classification maps to the correct blocked state via applyExecutionResult", () => {
  const cases = [
    ["MODEL_NOT_FOUND", "rejected"],
    ["MODEL_REJECTED", "rejected"],
    ["MODEL_UNAVAILABLE", "unavailable"],
    ["AUTHENTICATION_FAILED", "authentication_blocked"],
    ["QUOTA_EXHAUSTED", "quota_blocked"],
    ["ENTITLEMENT_REQUIRED", "entitlement_blocked"],
    ["CONFIGURATION_ERROR", "configuration_blocked"],
    ["PROVIDER_OFFLINE", "provider_offline"]
  ];
  for (const [classification, expectedState] of cases) {
    const catalog = defaultCatalog();
    applyExecutionResult(catalog, "codex", "gpt-x", { success: false, classification });
    assert.equal(catalog.providers.codex.models["gpt-x"].state, expectedState, classification);
    assert.equal(catalog.providers.codex.models["gpt-x"].automaticEligibility, false, classification);
  }
});

test("listCatalogEntries annotates automaticEligibility live from state+TTL, not from the stored flag alone", () => {
  const now = Date.now();
  const catalog = defaultCatalog();
  replaceProviderModels(
    catalog,
    "claude",
    [{ modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" }],
    { now: new Date(now - 30 * 3_600_000).toISOString() }
  );
  const entries = listCatalogEntries(catalog, "claude", { ttlHours: 24, now });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].automaticEligibility, false, "validated-but-expired must read as ineligible even if the stored flag says otherwise");
});

test("loadCatalog/saveCatalog round-trip through an isolated data directory (atomic write)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-catalog-store-"));
  const previousCwd = process.cwd();
  process.chdir(tmp);
  try {
    const mod = await import(`../src/modelCatalog.js?t=${Date.now()}-${Math.random()}`);
    const empty = await mod.loadCatalog();
    assert.deepEqual(empty, mod.defaultCatalog());

    const catalog = mod.defaultCatalog();
    mod.replaceProviderModels(catalog, "claude", [
      { modelId: "claude-opus-5", displayName: "Opus 5", state: "validated", discoverySource: "documented_candidate" }
    ]);
    await mod.saveCatalog(catalog);

    const reloaded = await mod.loadCatalog();
    assert.equal(reloaded.providers.claude.models["claude-opus-5"].state, "validated");
    assert.ok(fs.existsSync(path.join(tmp, "data", "model-catalog.json")));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
