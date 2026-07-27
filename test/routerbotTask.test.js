import assert from "node:assert/strict";
import test from "node:test";
import { extractRouterbotTask, resolveExplicitTask } from "../src/routerbotTask.js";

test("extractRouterbotTask reads metadata.routerbot_task", () => {
  assert.equal(
    extractRouterbotTask({ metadata: { routerbot_task: "ghost" } }, {}),
    "ghost"
  );
});

test("extractRouterbotTask reads x-routerbot-task header", () => {
  assert.equal(extractRouterbotTask({}, { "x-routerbot-task": "Review" }), "review");
});

test("resolveExplicitTask requires configured task route", () => {
  const config = { routing: { taskRoutes: { ghost: "claude" } } };
  assert.equal(resolveExplicitTask("ghost", config), "ghost");
  assert.equal(resolveExplicitTask("unknown", config), null);
});
