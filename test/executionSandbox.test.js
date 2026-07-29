import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-runtime-test-"));
process.env.PARAGON_RUNTIME_ROOT = runtimeRoot;

const { createIsolatedRuntimeDir, releaseIsolatedRuntimeDir } = await import("../src/executionSandbox.js");

test("createIsolatedRuntimeDir returns a fresh, existing directory under the runtime root", () => {
  const dir = createIsolatedRuntimeDir();
  assert.ok(fs.existsSync(dir));
  assert.ok(path.resolve(dir).startsWith(path.resolve(runtimeRoot)));
});

test("createIsolatedRuntimeDir never returns process.cwd() or PARAGON's own checkout", () => {
  const dir = createIsolatedRuntimeDir();
  assert.notEqual(path.resolve(dir), process.cwd());
  assert.ok(!path.resolve(dir).startsWith(process.cwd() + path.sep));
});

test("two calls to createIsolatedRuntimeDir produce distinct directories", () => {
  const a = createIsolatedRuntimeDir();
  const b = createIsolatedRuntimeDir();
  assert.notEqual(a, b);
  assert.ok(fs.existsSync(a));
  assert.ok(fs.existsSync(b));
});

test("releaseIsolatedRuntimeDir removes the directory and its contents", () => {
  const dir = createIsolatedRuntimeDir();
  fs.writeFileSync(path.join(dir, "scratch.txt"), "hello");
  releaseIsolatedRuntimeDir(dir);
  assert.ok(!fs.existsSync(dir));
});

test("releaseIsolatedRuntimeDir refuses to remove anything outside the runtime root", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-outside-"));
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep me");
  releaseIsolatedRuntimeDir(outside);
  assert.ok(fs.existsSync(outside), "directory outside the runtime root must survive release");
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
});

test("releaseIsolatedRuntimeDir is a no-op for null/undefined", () => {
  assert.doesNotThrow(() => releaseIsolatedRuntimeDir(null));
  assert.doesNotThrow(() => releaseIsolatedRuntimeDir(undefined));
});
