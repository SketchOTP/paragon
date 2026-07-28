import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_FLOWS, authFlowFor } from "../src/authFlows.js";
import { getAuthState } from "../src/cli.js";

test("authFlowFor returns metadata for built-in providers", () => {
  assert.equal(authFlowFor("codex").mode, "device");
  // claude's current CLI (verified by hand) prompts "Paste code here if
  // prompted >" after the browser step — a manual code-exchange flow, not
  // pure browser-only.
  assert.equal(authFlowFor("claude").mode, "oauth-code");
  assert.ok(authFlowFor("unknown").signInLabel);
});

test("AUTH_FLOWS covers all built-in CLI providers", () => {
  for (const provider of ["claude", "codex", "cursor"]) {
    assert.ok(AUTH_FLOWS[provider]?.mode);
    assert.ok(AUTH_FLOWS[provider]?.hint);
  }
});

test("getAuthState reports idle when no auth running", () => {
  const state = getAuthState("claude");
  assert.equal(state.provider, "claude");
  assert.equal(state.inProgress, false);
  assert.equal(state.flow.mode, "oauth-code");
});
