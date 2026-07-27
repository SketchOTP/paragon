import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResponseObject,
  looksLikeResponsesPayload,
  responsesInputToPrompt,
  responsesToChatCompletion
} from "../src/responsesFormat.js";

test("looksLikeResponsesPayload detects Cursor Agent payloads", () => {
  assert.equal(looksLikeResponsesPayload({ input: "hello" }), true);
  assert.equal(looksLikeResponsesPayload({ instructions: "be helpful", input: [] }), true);
  assert.equal(looksLikeResponsesPayload({ messages: [{ role: "user", content: "hi" }] }), false);
  assert.equal(looksLikeResponsesPayload({ model: "gpt-5", truncation: "auto" }), true);
});

test("responsesInputToPrompt flattens instructions and message items", () => {
  const prompt = responsesInputToPrompt({
    instructions: "You are RouterBot",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { type: "function_call_output", output: "ok" }
    ]
  });
  assert.match(prompt, /SYSTEM:\nYou are RouterBot/);
  assert.match(prompt, /USER:\nFix the bug/);
  assert.match(prompt, /TOOL_OUTPUT:\nok/);
});

test("responsesToChatCompletion maps assistant text", () => {
  const response = buildResponseObject({
    model: "routerbot-local",
    content: "Done.",
    provider: "codex",
    routedProvider: "codex",
    durationMs: 42
  });
  const chat = responsesToChatCompletion(response);
  assert.equal(chat.object, "chat.completion");
  assert.equal(chat.choices[0].message.content, "Done.");
  assert.equal(chat.choices[0].finish_reason, "stop");
});
