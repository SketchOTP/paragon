import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "./env.js";

/** Real default lives outside the repo; tests override via PARAGON_RUNTIME_ROOT. */
function getRuntimeRoot() {
  const override = getEnv("RUNTIME_ROOT");
  const root = override ? path.resolve(override) : path.join(os.homedir(), ".local", "share", "paragon", "runtime");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * PARAGON is a transparent OpenAI-compatible model gateway (PARAGON-D-004B-R):
 * clients like Cursor send only messages, never a filesystem path, and
 * provider CLIs must never run against PARAGON's own checkout or a real
 * project. Every provider invocation gets its own throwaway directory here
 * — created fresh per request, destroyed after.
 */
export function createIsolatedRuntimeDir(requestId = crypto.randomUUID()) {
  const dir = path.join(getRuntimeRoot(), requestId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function releaseIsolatedRuntimeDir(dir) {
  if (!dir) {
    return;
  }
  const root = getRuntimeRoot();
  const resolved = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return; // never rm anything outside the runtime root
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

/** Stable (non-per-request) scratch dir for CLI auth/model-listing calls, which aren't part of a chat completion. */
let neutralDir = null;
export function getNeutralExecutionDir() {
  if (neutralDir) {
    return neutralDir;
  }
  const dir = path.join(getRuntimeRoot(), ".neutral-cwd");
  fs.mkdirSync(dir, { recursive: true });
  neutralDir = dir;
  return dir;
}
