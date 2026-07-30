import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/configStore.js";
import { defaultConfig } from "../src/defaultConfig.js";
import { requestHasApiKey, isLoopback } from "../src/auth.js";
import { expandArgs } from "../src/cli.js";


test("mergeConfig preserves custom providers", () => {
  const merged = mergeConfig(defaultConfig, {
    providers: {
      "ollama-local": {
        type: "http",
        label: "Ollama",
        enabled: true,
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2"
      }
    }
  });
  assert.ok(merged.providers["ollama-local"]);
  assert.equal(merged.providers["ollama-local"].model, "llama3.2");
  assert.ok(merged.providers.codex);
});

test("mergeConfig merges server and routing", () => {
  const merged = mergeConfig(defaultConfig, {
    server: { tailscaleHost: "test.tail.ts.net" },
    routing: { priority: "cost" }
  });
  assert.equal(merged.server.tailscaleHost, "test.tail.ts.net");
  assert.equal(merged.routing.priority, "cost");
});

test("requestHasApiKey accepts bearer, header, and query", () => {
  const key = "secret-key";
  assert.ok(
    requestHasApiKey({ get: (h) => (h === "authorization" ? "Bearer secret-key" : undefined), query: {} }, key)
  );
  assert.ok(requestHasApiKey({ get: (h) => (h === "x-api-key" ? "secret-key" : undefined), query: {} }, key));
  assert.ok(requestHasApiKey({ get: () => undefined, query: { key: "secret-key" } }, key));
  assert.ok(!requestHasApiKey({ get: () => undefined, query: {} }, key));
});

test("isLoopback detects localhost", () => {
  assert.ok(isLoopback({ socket: { remoteAddress: "127.0.0.1" }, get: () => undefined }));
  assert.ok(isLoopback({ socket: { remoteAddress: "::1" }, get: () => undefined }));
  assert.ok(!isLoopback({ socket: { remoteAddress: "10.0.0.1" }, get: () => undefined }));
});

test("expandArgs substitutes model placeholder", () => {
  assert.deepEqual(expandArgs(["-m", "{{model}}", "-"], "llama3"), ["-m", "llama3", "-"]);
});

// PARAGON-D-004C1 (P0-1): buildProviderAttempts() and its config-derived
// fallback chain were removed — it was a dispatch path that bypassed
// catalog eligibility, the cost ceiling, and the chat-capability gate.
// Attempt-chain construction is now covered by router.test.js
// (buildRankedAttempts / verifyAttemptsAgainstRegistry) and
// routingIntegrity.test.js, which assert against the eligible registry
// rather than config.
test("providerFallback no longer exports a config-derived dispatch path", async () => {
  const providerFallback = await import("../src/providerFallback.js");
  assert.equal(providerFallback.buildProviderAttempts, undefined);
});

test("defaultConfig has no personal hostnames", () => {
  const json = JSON.stringify(defaultConfig);
  const forbiddenTailnet = ["tail", "1a5964"].join("");
  assert.ok(!json.includes("atlas"));
  assert.ok(!json.includes(forbiddenTailnet));
  assert.equal(defaultConfig.server.tailscaleHost, "");
  assert.equal(defaultConfig.server.apiKey, "");
});

test("defaultConfig includes provider icons", () => {
  assert.equal(defaultConfig.providers.claude.icon, "🧠");
  assert.equal(defaultConfig.providers.codex.icon, "⚡");
});

test("mergeConfig preserves provider icon", () => {
  const merged = mergeConfig(defaultConfig, {
    providers: {
      "ollama-local": { type: "http", label: "Ollama", icon: "🦙", enabled: true }
    }
  });
  assert.equal(merged.providers["ollama-local"].icon, "🦙");
});
