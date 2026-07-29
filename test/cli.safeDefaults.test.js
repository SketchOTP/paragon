import assert from "node:assert/strict";
import test from "node:test";
import { getProviderSpec } from "../src/cli.js";

// PARAGON-D-004B-R: PARAGON is a transparent model gateway, not an
// autonomous repo-editing agent. Every builtin provider always runs
// tools-disabled / read-only — there is no client-controlled mode that
// unlocks write access, because there is no workspace concept any more.

test("claude runArgs is always tools-disabled", () => {
  const args = getProviderSpec("claude", {}).runArgs({ model: "" });
  assert.equal(args[args.indexOf("--tools") + 1], "");
});

test("codex runArgs is always read-only sandbox", () => {
  const args = getProviderSpec("codex", {}).runArgs({ model: "" });
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});

test("cursor runArgs is always ask mode, never --force", () => {
  const args = getProviderSpec("cursor", {}).runArgs({ model: "" });
  assert.ok(!args.includes("--force"));
  assert.equal(args[args.indexOf("--mode") + 1], "ask");
});

test("no provider's runArgs accepts a workspaceMode argument to unlock write access", () => {
  for (const provider of ["claude", "codex", "cursor"]) {
    const withExtra = getProviderSpec(provider, {}).runArgs({ model: "", workspaceMode: "direct" });
    const withoutExtra = getProviderSpec(provider, {}).runArgs({ model: "" });
    assert.deepEqual(withExtra, withoutExtra, `${provider} must ignore any workspaceMode-like hint`);
  }
});
