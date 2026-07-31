import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyWorkspaceArtifact } from "../src/routing/codexQualification.js";

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "paragon-codex-test-"));
}

test("a persisted Codex artifact qualifies by exact bytes", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "codex-expert-proof.txt"), "PARAGON_CODEX_EXPERT_OK\n");
  const result = await verifyWorkspaceArtifact({
    workspace: root,
    relativePath: "codex-expert-proof.txt",
    expectedContent: "PARAGON_CODEX_EXPERT_OK\n"
  });
  assert.equal(result.bytes, 24);
});

test("missing artifact or success prose cannot qualify a zero-exit attempt", async () => {
  const root = await workspace();
  await assert.rejects(
    verifyWorkspaceArtifact({ workspace: root, relativePath: "codex-expert-proof.txt", expectedContent: "PARAGON_CODEX_EXPERT_OK\n" }),
    /missing/
  );
});

test("an artifact outside the registered workspace is rejected", async () => {
  const root = await workspace();
  const outside = path.join(path.dirname(root), "outside-proof.txt");
  await fs.writeFile(outside, "PARAGON_CODEX_EXPERT_OK\n");
  await assert.rejects(
    verifyWorkspaceArtifact({ workspace: root, relativePath: "../outside-proof.txt", expectedContent: "PARAGON_CODEX_EXPERT_OK\n" }),
    /escapes/
  );
});
