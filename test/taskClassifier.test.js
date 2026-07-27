import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask } from "../src/taskClassifier.js";

test("classifyTask defaults to code for unknown input", async () => {
  assert.equal(await classifyTask("hello", { routing: { taskPatterns: {} }, providers: {} }), "code");
});

test("classifyTask detects debug tasks", async () => {
  assert.equal(await classifyTask("This is a bug fix", { routing: { taskPatterns: {} }, providers: {} }), "debug");
});

test("classifyTask detects custom task patterns", async () => {
  const config = {
    routing: {
      taskPatterns: {
        translate: "\\b(translate|spanish|french)\\b"
      }
    },
    providers: {}
  };
  assert.equal(await classifyTask("Translate this to spanish", config), "translate");
});

test("classifyTask respects match count for tie-breaking", async () => {
  const config = {
    routing: {
      taskPatterns: {
        debug: "\\b(bug)\\b",
        code: "\\b(implement)\\b"
      }
    },
    providers: {}
  };
  // 'bug' matches once, 'implement' matches twice
  assert.equal(await classifyTask("bug implement implement", config), "code");
});

const emptyConfig = { routing: { taskPatterns: {} }, providers: {} };

test("classifyTask expanded ask patterns", async () => {
  assert.equal(await classifyTask("What's the difference between Redis and Memcached?", emptyConfig), "ask");
  assert.equal(await classifyTask("Can you tell me about OAuth2 flows?", emptyConfig), "ask");
  assert.equal(await classifyTask("Pros and cons of using SQLite here?", emptyConfig), "ask");
  assert.equal(await classifyTask("Curious about how rate limiting works", emptyConfig), "ask");
});

test("classifyTask expanded debug patterns", async () => {
  assert.equal(await classifyTask("CI failed on the main branch", emptyConfig), "debug");
  assert.equal(await classifyTask("Getting a TypeError when clicking submit", emptyConfig), "debug");
  assert.equal(await classifyTask("This is flaky in production only", emptyConfig), "debug");
  assert.equal(await classifyTask("Something broke after the last deploy", emptyConfig), "debug");
});

test("classifyTask expanded plan patterns", async () => {
  assert.equal(await classifyTask("Draft an implementation plan for the auth service", emptyConfig), "plan");
  assert.equal(await classifyTask("Compare approaches for caching strategy", emptyConfig), "plan");
  assert.equal(await classifyTask("What is the rollout plan for phase 2?", emptyConfig), "plan");
});

test("classifyTask expanded agent patterns", async () => {
  assert.equal(await classifyTask("Wire up the webhook handler in this repo", emptyConfig), "agent");
  assert.equal(await classifyTask("Migrate the config module to TypeScript", emptyConfig), "agent");
  assert.equal(await classifyTask("Resolve the merge conflict in package.json", emptyConfig), "agent");
  assert.equal(await classifyTask("Address the review comments on this PR", emptyConfig), "agent");
});

test("classifyTask expanded review patterns", async () => {
  assert.equal(await classifyTask("Please do a security review of this PR", emptyConfig), "review");
  assert.equal(await classifyTask("Can you double check my implementation?", emptyConfig), "review");
});

test("classifyTask expanded docs patterns", async () => {
  assert.equal(await classifyTask("Update the README with setup instructions", emptyConfig), "docs");
  assert.equal(await classifyTask("Write a runbook for on-call", emptyConfig), "docs");
});

test("classifyTask expanded explain patterns", async () => {
  assert.equal(await classifyTask("ELI5 how JWT validation works", emptyConfig), "explain");
  assert.equal(await classifyTask("Give me a primer on event sourcing", emptyConfig), "explain");
});

test("classifyTask expanded code patterns", async () => {
  assert.equal(await classifyTask("Build a FastAPI endpoint for user signup", emptyConfig), "code");
  assert.equal(await classifyTask("Write a bash script to rotate logs", emptyConfig), "code");
});

test("classifyTask expanded quick patterns", async () => {
  assert.equal(await classifyTask("TL;DR what changed?", emptyConfig), "quick");
  assert.equal(await classifyTask("Just the answer, no preamble", emptyConfig), "quick");
});

test("classifyTask expanded multitask patterns", async () => {
  assert.equal(await classifyTask("Run these subtasks in parallel with workers", emptyConfig), "multitask");
  assert.equal(await classifyTask("Spin up a fleet of agents for each file", emptyConfig), "multitask");
});
