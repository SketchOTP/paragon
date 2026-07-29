import assert from "node:assert/strict";
import test from "node:test";
import { defaultCatalog } from "../src/modelCatalog.js";
import { refreshAllProviders, refreshProviderCatalog } from "../src/modelCatalogRefresh.js";

// Deliberately not a real binary — isolates these tests from whatever CLIs
// happen to be installed on the machine running the suite (loadClaudeBundledCatalog
// and getCliVersion both fail closed to [] / null on ENOENT).
const FAKE_COMMAND = "definitely-not-a-real-cli-xyz";

test("refreshProviderCatalog: Claude candidates are always candidate-only unless bounded-validated — static/documented entries never grant eligibility by themselves", async () => {
  const catalog = defaultCatalog();
  const probed = [];
  const probeFn = async (_provider, _cfg, modelId) => {
    probed.push(modelId);
    return modelId === "claude-opus-5" ? { success: true } : { success: false, classification: "MODEL_NOT_FOUND" };
  };

  const result = await refreshProviderCatalog(
    "claude",
    { command: FAKE_COMMAND },
    catalog,
    { maxValidationProbesPerProvider: 2, probeFn }
  );

  assert.equal(probed.length, 2, "must never probe more than maxValidationProbesPerProvider candidates");
  const models = catalog.providers.claude.models;
  assert.equal(models["claude-opus-5"].state, "validated");
  assert.equal(models["claude-opus-5"].automaticEligibility, true);
  assert.equal(models["claude-sonnet-5"].state, "rejected");
  assert.equal(models["claude-sonnet-5"].automaticEligibility, false);
  assert.equal(result.rejectedNow, 1);

  // Documented candidates never probed this cycle (outside the bound) stay
  // "unknown" — a static list entry never grants eligibility on its own.
  const unprobedConcrete = Object.values(models).find((m) => !m.isAlias && !probed.includes(m.modelId) && m.modelId !== "claude-opus-5" && m.modelId !== "claude-sonnet-5");
  assert.ok(unprobedConcrete, "expected at least one unprobed concrete candidate");
  assert.equal(unprobedConcrete.state, "unknown");
  assert.equal(unprobedConcrete.automaticEligibility, false);

  // Aliases (opus/sonnet/haiku/fable) are recorded but never auto-eligible
  // from discovery alone, and never counted toward the probe budget.
  const alias = models.opus;
  assert.ok(alias, "expected the 'opus' alias to be recorded");
  assert.equal(alias.isAlias, true);
  assert.equal(alias.automaticEligibility, false);
  assert.ok(!probed.includes("opus"), "aliases must never consume the validation probe budget");
});

test("refreshProviderCatalog: HTTP provider trusts /v1/models as authoritative (exposed), no probe required", async () => {
  const catalog = defaultCatalog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/v1\/models$/);
    return {
      ok: true,
      json: async () => ({ data: [{ id: "local-model-a" }, { id: "local-model-b" }] })
    };
  };
  try {
    const result = await refreshProviderCatalog("lmstudio", { type: "http", baseUrl: "http://127.0.0.1:1234" }, catalog, {});
    assert.equal(result.added, 2);
    const models = catalog.providers.lmstudio.models;
    assert.equal(models["local-model-a"].state, "exposed");
    assert.equal(models["local-model-a"].automaticEligibility, true);
    assert.equal(models["local-model-a"].discoverySource, "http_models_endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshProviderCatalog: a successful refresh is authoritative replacement — a model absent from this cycle is retired, never left eligible", async () => {
  const catalog = defaultCatalog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }) });
  try {
    await refreshProviderCatalog("http1", { type: "http", baseUrl: "http://x" }, catalog, {});
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "model-a" }] }) });
    await refreshProviderCatalog("http1", { type: "http", baseUrl: "http://x" }, catalog, {});
    assert.equal(catalog.providers.http1.models["model-a"].state, "exposed");
    assert.equal(catalog.providers.http1.models["model-b"].state, "retired");
    assert.equal(catalog.providers.http1.models["model-b"].automaticEligibility, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshProviderCatalog: a failing discovery call throws (caller must keep the previous entries, not replace with synthetic defaults)", async () => {
  const catalog = defaultCatalog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    await assert.rejects(() => refreshProviderCatalog("http1", { type: "http", baseUrl: "http://x" }, catalog, {}));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshAllProviders continues past one provider's discovery failure and still refreshes the rest", async () => {
  const config = {
    providers: {
      broken: { enabled: true, type: "http", baseUrl: "http://broken" },
      working: { enabled: true, type: "http", baseUrl: "http://working" },
      disabled: { enabled: false, type: "http", baseUrl: "http://disabled" }
    }
  };
  const catalog = defaultCatalog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("broken")) {
      throw new Error("ECONNREFUSED");
    }
    return { ok: true, json: async () => ({ data: [{ id: "good-model" }] }) };
  };
  try {
    const outcomes = await refreshAllProviders(config, catalog, {});
    assert.equal(outcomes.broken.ok, false);
    assert.equal(outcomes.working.ok, true);
    assert.ok(!("disabled" in outcomes), "disabled providers must never be refreshed");
    assert.equal(catalog.providers.working.models["good-model"].state, "exposed");
    assert.ok(!catalog.providers.broken, "a broken provider's discovery failure must not fabricate an empty/replaced bucket");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
