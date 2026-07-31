import fs from "node:fs/promises";
import path from "node:path";

/** Verify a Codex artifact independently of CLI prose or process exit code. */
export async function verifyWorkspaceArtifact({ workspace, relativePath, expectedContent }) {
  const root = await fs.realpath(workspace);
  const candidate = path.resolve(root, relativePath ?? "");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("artifact path escapes the registered workspace");
  }
  const actualPath = await fs.realpath(candidate).catch(() => null);
  if (!actualPath || (actualPath !== root && !actualPath.startsWith(`${root}${path.sep}`))) {
    throw new Error("artifact is missing or resolves outside the registered workspace");
  }
  const stat = await fs.stat(actualPath);
  if (!stat.isFile()) {
    throw new Error("artifact is not a regular file");
  }
  const actual = await fs.readFile(actualPath);
  const expected = Buffer.from(String(expectedContent ?? ""));
  if (!actual.equals(expected)) {
    throw new Error("artifact content does not match exactly");
  }
  return { path: actualPath, bytes: actual.length };
}
