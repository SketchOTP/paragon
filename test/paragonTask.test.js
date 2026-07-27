import assert from "node:assert/strict";
import test from "node:test";
import { extractParagonTask, resolveExplicitTask } from "../src/paragonTask.js";

test("extractParagonTask reads metadata.paragon_task", () => {
  assert.equal(
    extractParagonTask({ metadata: { paragon_task: "ghost" } }, {}),
    "ghost"
  );
});

test("extractParagonTask reads x-paragon-task header", () => {
  assert.equal(extractParagonTask({}, { "x-paragon-task": "Review" }), "review");
});

test("extractParagonTask still reads legacy metadata.routerbot_task", () => {
  assert.equal(
    extractParagonTask({ metadata: { routerbot_task: "ghost" } }, {}),
    "ghost"
  );
});

test("extractParagonTask still reads legacy x-routerbot-task header", () => {
  assert.equal(extractParagonTask({}, { "x-routerbot-task": "review" }), "review");
});

test("extractParagonTask prefers modern header over legacy", () => {
  assert.equal(
    extractParagonTask({}, { "x-paragon-task": "code", "x-routerbot-task": "review" }),
    "code"
  );
});

test("resolveExplicitTask requires configured task route", () => {
  const config = { routing: { taskRoutes: { ghost: "claude" } } };
  assert.equal(resolveExplicitTask("ghost", config), "ghost");
  assert.equal(resolveExplicitTask("unknown", config), null);
});
