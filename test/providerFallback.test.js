import assert from "node:assert/strict";
import test from "node:test";

import { formatProviderError, summarizeProviderStderr } from "../src/providerFallback.js";

test("summarizeProviderStderr keeps codex usage limit line", () => {
  const stderr = `OpenAI Codex v0.122.0 (research preview)
--------
workdir: /tmp
model: gpt-5.4-mini
--------
user
SYSTEM: huge prompt...
USER: # Project goal
ERROR: You've hit your usage limit. Try again tomorrow.`;

  assert.equal(
    summarizeProviderStderr(stderr),
    "ERROR: You've hit your usage limit. Try again tomorrow."
  );
});

test("summarizeProviderStderr keeps claude weekly limit line", () => {
  assert.equal(
    summarizeProviderStderr("You've hit your weekly limit · resets 5am (America/New_York)"),
    "You've hit your weekly limit · resets 5am (America/New_York)"
  );
});

test("formatProviderError does not repeat full codex stderr", () => {
  const error = new Error(`OpenAI Codex v0.122.0
--------
user
SYSTEM: ${"x".repeat(2000)}
ERROR: You've hit your usage limit.`);
  error.code = 1;
  error.stderr = error.message;

  const formatted = formatProviderError(error);
  assert.match(formatted, /^exited 1: ERROR: You've hit your usage limit\./);
  assert.ok(formatted.length < 200);
});
