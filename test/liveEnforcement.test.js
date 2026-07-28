import assert from "node:assert/strict";
import test from "node:test";

import {
  activeExecutionCount,
  applyFallbackLimit,
  beginExecution,
  checkConcurrency,
  checkContextCeiling,
  circuitStateSnapshot,
  endExecution,
  filterOpenCircuits,
  isCircuitOpen,
  recordProviderResult,
  resetForTests
} from "../src/orchestration/liveEnforcement.js";
import { DEFAULT_ORCHESTRATION_CONFIG, validatePolicy } from "../src/orchestration/governorPolicy.js";
import { migrateOrchestrationMode } from "../src/configMigrate.js";

test.beforeEach(() => {
  resetForTests();
});

test("checkContextCeiling blocks at or above the ceiling, not below", () => {
  const policy = DEFAULT_ORCHESTRATION_CONFIG;
  assert.equal(checkContextCeiling(policy, policy.context.absoluteCeilingTokens - 1).blocked, false);
  assert.equal(checkContextCeiling(policy, policy.context.absoluteCeilingTokens).blocked, true);
});

test("checkConcurrency blocks once active executions reach the configured max", () => {
  const policy = { concurrency: { maxConcurrent: 2 } };
  assert.equal(checkConcurrency(policy).blocked, false);
  beginExecution();
  beginExecution();
  assert.equal(activeExecutionCount(), 2);
  assert.equal(checkConcurrency(policy).blocked, true);
  endExecution();
  assert.equal(activeExecutionCount(), 1);
  assert.equal(checkConcurrency(policy).blocked, false);
});

test("applyFallbackLimit caps the attempt chain without reordering", () => {
  const policy = { fallback: { maxAttempts: 2 } };
  const attempts = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const limited = applyFallbackLimit(policy, attempts);
  assert.deepEqual(limited.map((a) => a.name), ["a", "b"]);
});

test("circuit breaker opens after failureThreshold, blocks, then half-opens after cooldown", async () => {
  const policy = { circuitBreaker: { failureThreshold: 2, cooldownMs: 20 } };
  recordProviderResult(policy, "flaky", false);
  assert.equal(isCircuitOpen("flaky"), false);
  recordProviderResult(policy, "flaky", false);
  assert.equal(isCircuitOpen("flaky"), true);
  assert.equal(circuitStateSnapshot().flaky, "open");

  const attempts = [{ name: "flaky" }, { name: "healthy" }];
  assert.deepEqual(
    filterOpenCircuits(attempts).map((a) => a.name),
    ["healthy"]
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(isCircuitOpen("flaky"), false, "circuit should half-open past cooldown");
});

test("circuit breaker resets failure count on success", () => {
  const policy = { circuitBreaker: { failureThreshold: 2, cooldownMs: 1000 } };
  recordProviderResult(policy, "recovering", false);
  recordProviderResult(policy, "recovering", true);
  recordProviderResult(policy, "recovering", false);
  assert.equal(isCircuitOpen("recovering"), false, "a single failure after a success must not reopen the circuit");
});

test("validatePolicy accepts off/live and rejects shadow directly", () => {
  const live = validatePolicy(DEFAULT_ORCHESTRATION_CONFIG);
  assert.equal(live.ok, true);

  const off = validatePolicy({ ...DEFAULT_ORCHESTRATION_CONFIG, mode: "off" });
  assert.equal(off.ok, true);

  const shadow = validatePolicy({ ...DEFAULT_ORCHESTRATION_CONFIG, mode: "shadow" });
  assert.equal(shadow.ok, false);
  assert.ok(shadow.errors.some((e) => e.includes("mode must be one of")));
});

test("validatePolicy enforces the new numeric enforcement fields", () => {
  const bad = validatePolicy({
    ...DEFAULT_ORCHESTRATION_CONFIG,
    concurrency: { maxConcurrent: 0 },
    fallback: { maxAttempts: -1 },
    circuitBreaker: { failureThreshold: 0, cooldownMs: 0 }
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("concurrency.maxConcurrent")));
  assert.ok(bad.errors.some((e) => e.includes("fallback.maxAttempts")));
  assert.ok(bad.errors.some((e) => e.includes("circuitBreaker.failureThreshold")));
  assert.ok(bad.errors.some((e) => e.includes("circuitBreaker.cooldownMs")));
});

test("migrateOrchestrationMode converts legacy shadow to live and is idempotent", () => {
  const shadowConfig = { orchestration: { ...DEFAULT_ORCHESTRATION_CONFIG, mode: "shadow" } };
  const migrated = migrateOrchestrationMode(shadowConfig);
  assert.equal(migrated.orchestration.mode, "live");

  const alreadyLive = migrateOrchestrationMode(migrated);
  assert.equal(alreadyLive, migrated, "no-op when mode is already live");

  const offConfig = { orchestration: { ...DEFAULT_ORCHESTRATION_CONFIG, mode: "off" } };
  assert.equal(migrateOrchestrationMode(offConfig), offConfig, "off is left untouched");
});
