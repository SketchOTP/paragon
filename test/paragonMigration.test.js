import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_VERSION, LEGACY_EXPOSED_MODEL_ALIAS, defaultConfig } from "../src/defaultConfig.js";
import { migrateToParagon } from "../src/configMigrate.js";
import { getEnv } from "../src/env.js";

test("defaultConfig exposes paragon as the canonical model id", () => {
  assert.equal(defaultConfig.server.exposedModel, "paragon");
});

test("migrateToParagon rewrites the legacy exposed model alias", () => {
  const legacyConfig = {
    ...defaultConfig,
    configVersion: 1,
    server: { ...defaultConfig.server, exposedModel: LEGACY_EXPOSED_MODEL_ALIAS }
  };
  const migrated = migrateToParagon(legacyConfig);
  assert.equal(migrated.server.exposedModel, "paragon");
  assert.equal(migrated.configVersion, CONFIG_VERSION);
});

test("migrateToParagon preserves a user-chosen exposed model", () => {
  const config = { ...defaultConfig, configVersion: 1, server: { ...defaultConfig.server, exposedModel: "my-custom-model" } };
  const migrated = migrateToParagon(config);
  assert.equal(migrated.server.exposedModel, "my-custom-model");
  assert.equal(migrated.configVersion, CONFIG_VERSION);
});

test("migrateToParagon is idempotent", () => {
  const once = migrateToParagon({ ...defaultConfig, configVersion: 1 });
  const twice = migrateToParagon(once);
  assert.deepEqual(once, twice);
});

test("migrateToParagon never touches unrelated settings", () => {
  const config = {
    ...defaultConfig,
    configVersion: 1,
    server: { ...defaultConfig.server, apiKey: "secret-key", host: "0.0.0.0" }
  };
  const migrated = migrateToParagon(config);
  assert.equal(migrated.server.apiKey, "secret-key");
  assert.equal(migrated.server.host, "0.0.0.0");
});

test("getEnv prefers PARAGON_ over legacy ROUTERBOT_ spelling", () => {
  const key = "TEST_MIGRATION_PROBE";
  process.env[`PARAGON_${key}`] = "modern";
  process.env[`ROUTERBOT_${key}`] = "legacy";
  try {
    assert.equal(getEnv(key), "modern");
  } finally {
    delete process.env[`PARAGON_${key}`];
    delete process.env[`ROUTERBOT_${key}`];
  }
});

test("getEnv falls back to legacy ROUTERBOT_ spelling when PARAGON_ is unset", () => {
  const key = "TEST_MIGRATION_PROBE_2";
  process.env[`ROUTERBOT_${key}`] = "legacy-value";
  try {
    assert.equal(getEnv(key), "legacy-value");
  } finally {
    delete process.env[`ROUTERBOT_${key}`];
  }
});

test("getEnv returns undefined when neither spelling is set", () => {
  assert.equal(getEnv("TEST_MIGRATION_PROBE_UNSET"), undefined);
});
