import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorModeToCliArgs,
  extractCursorMode,
  normalizeCursorMode
} from "../src/cursorMode.js";
import { classifyTask } from "../src/taskClassifier.js";

test("normalizeCursorMode accepts Cursor mode aliases", () => {
  assert.equal(normalizeCursorMode("Agent"), "agent");
  assert.equal(normalizeCursorMode("composer"), "agent");
  assert.equal(normalizeCursorMode("multitasking"), "multitask");
});

test("extractCursorMode reads metadata.mode", () => {
  assert.equal(
    extractCursorMode({ metadata: { mode: "plan" }, input: "Design auth" }),
    "plan"
  );
  assert.equal(
    extractCursorMode({ metadata: { cursor_mode: "debug" }, input: "crash log" }),
    "debug"
  );
});

test("extractCursorMode reads mode from headers", () => {
  assert.equal(
    extractCursorMode({ messages: [{ role: "user", content: "hi" }] }, { "x-cursor-mode": "plan" }),
    "plan"
  );
});

test("extractCursorMode reads plan from system message", () => {
  assert.equal(
    extractCursorMode({
      messages: [
        { role: "system", content: "You are in plan mode. Propose steps only." },
        { role: "user", content: "plan a calculator" }
      ]
    }),
    "plan"
  );
});

test("extractCursorMode does not force messages payloads to ask", () => {
  assert.equal(
    extractCursorMode({ messages: [{ role: "user", content: "plan a simple calculator" }] }),
    null
  );
});

test("plan prompt classifies to plan task when mode is unknown", async () => {
  const task = await classifyTask("plan a simple calculator", { routing: { taskPatterns: {} }, providers: {} });
  assert.equal(task, "plan");
});

test("extractCursorMode infers agent from responses payloads", () => {
  assert.equal(
    extractCursorMode({
      model: "paragon",
      input: "edit files",
      stream: true,
      tools: [{ type: "function", name: "ApplyPatch" }],
      parallel_tool_calls: true
    }),
    "agent"
  );
});

test("cursorModeToCliArgs maps modes to cursor-agent flags", () => {
  assert.deepEqual(cursorModeToCliArgs("plan"), ["--print", "--trust", "--mode", "plan"]);
  assert.deepEqual(cursorModeToCliArgs("ask"), ["--print", "--trust", "--mode", "ask"]);
  assert.deepEqual(cursorModeToCliArgs("agent"), ["--print", "--trust", "--force"]);
});
