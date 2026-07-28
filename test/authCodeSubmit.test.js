import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { getAuthState, startAuth, submitAuthCode } from "../src/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures", "oauth-code-prompt.js");

const providerConfig = {
  type: "generic-cli",
  command: process.execPath,
  authArgs: [fixture],
  statusArgs: [],
  model: ""
};

test("submitAuthCode writes to the real in-progress auth child's stdin and unblocks it", async () => {
  const provider = "oauth-code-fixture";
  await startAuth(provider, providerConfig, { force: true });

  // Give the child a moment to print its prompt and register in authProcesses.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(getAuthState(provider).inProgress, true, "auth process should be tracked while running");

  const result = submitAuthCode(provider, "test-code-123");
  assert.deepEqual(result, { ok: true });

  // The fixture exits 0 immediately after receiving a non-empty line —
  // give it a moment, then confirm it's no longer tracked as in-progress.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(getAuthState(provider).inProgress, false, "process should have exited after receiving the code");
});

test("submitAuthCode rejects when no auth is in progress for that provider", () => {
  assert.throws(() => submitAuthCode("nobody-is-signing-in", "123"), /No .* login in progress/);
});

test("submitAuthCode rejects an empty code", () => {
  assert.throws(() => submitAuthCode("claude", ""), /Authorization code is required/);
});
