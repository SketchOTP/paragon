import assert from "node:assert/strict";
import test from "node:test";
import { runHttpProvider } from "../src/httpProvider.js";

test("runHttpProvider sets max_tokens on the request body only when providerConfig.maxTokens is given — never for a real completion", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] })
    };
  };
  try {
    await runHttpProvider("lmstudio", { baseUrl: "http://x", model: "m" }, "hello");
    assert.equal(capturedBody.max_tokens, undefined, "a normal completion must never be silently token-capped");

    await runHttpProvider("lmstudio", { baseUrl: "http://x", model: "m", maxTokens: 1 }, "Reply with exactly one word: ok");
    assert.equal(capturedBody.max_tokens, 1, "a validation probe with maxTokens set must forward it as max_tokens");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
