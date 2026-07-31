import assert from "node:assert/strict";
import test from "node:test";
import { getProviderSpec, parseCodexJsonlEvents } from "../src/cli.js";

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

test("native agent tool execution enables each CLI's own agent mode", () => {
  const claude = getProviderSpec("claude", {}).runArgs({ model: "sonnet", toolExecution: true });
  const codex = getProviderSpec("codex", {}).runArgs({ model: "gpt-5.4", toolExecution: true });
  const cursor = getProviderSpec("cursor", {}).runArgs({ model: "gpt-5.6-luna-max", toolExecution: true });
  assert.equal(claude[claude.indexOf("--tools") + 1], "default");
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(cursor.includes("--force"));
  assert.ok(claude.includes("sonnet"));
  assert.ok(codex.includes("gpt-5.4"));
  assert.ok(codex.includes("--json"));
  assert.ok(codex.includes("--ephemeral"));
  assert.ok(cursor.includes("gpt-5.6-luna-max"));
});

test("Codex failed JSONL tool events are not hidden by exit code zero", () => {
  const parsed = parseCodexJsonlEvents([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "failed", exit_code: 1 } }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n"));
  assert.equal(parsed.failedToolEvents.length, 1);
});

test("no provider's runArgs accepts a workspaceMode argument to unlock write access", () => {
  for (const provider of ["claude", "codex", "cursor"]) {
    const withExtra = getProviderSpec(provider, {}).runArgs({ model: "", workspaceMode: "direct" });
    const withoutExtra = getProviderSpec(provider, {}).runArgs({ model: "" });
    assert.deepEqual(withExtra, withoutExtra, `${provider} must ignore any workspaceMode-like hint`);
  }
});
