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

test("runHttpProvider forwards Cursor tool contracts and returns native tool calls", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"README.md"}' }
            }]
          }
        }]
      })
    };
  };
  try {
    const result = await runHttpProvider("http-tools", {
      baseUrl: "http://x",
      model: "tool-model"
    }, "fallback prompt", undefined, {
      requestBody: {
        messages: [
          { role: "user", content: "read README.md" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_previous", type: "function", function: { name: "list_files", arguments: "{}" } }]
          },
          { role: "tool", tool_call_id: "call_previous", content: "README.md" }
        ],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
        tool_choice: "auto"
      }
    });
    assert.deepEqual(capturedBody.messages, [
      { role: "user", content: "read README.md" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_previous", type: "function", function: { name: "list_files", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "call_previous", content: "README.md" }
    ]);
    assert.equal(capturedBody.tools[0].function.name, "read_file");
    assert.equal(capturedBody.tool_choice, "auto");
    assert.equal(capturedBody.model, "tool-model");
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls[0], {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runHttpProvider preserves streamed tool-call deltas and assembles the native call", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
    "data: [DONE]\n\n"
  ];
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            const value = chunks.shift();
            return value
              ? { done: false, value: new TextEncoder().encode(value) }
              : { done: true, value: undefined };
          }
        };
      }
    }
  });
  try {
    const result = await runHttpProvider("http-tools", { baseUrl: "http://x", model: "tool-model" }, "read", () => {});
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls, [{
      id: "call_",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' }
    }]);
    assert.equal(result.usage.totalBilledTokens, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
