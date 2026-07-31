#!/usr/bin/env node

/**
 * Qualification-only exact-tuple runner.
 *
 * This is intentionally not wired into the HTTP server or normal routing API.
 * It accepts one JSON object on stdin, requires a disposable registered
 * workspace below PARAGON_QUALIFICATION_ROOT, runs one exact tuple, and
 * writes bounded evidence beside that workspace.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runProvider } from "../src/cli.js";
import { executionMethodFor, expertTupleId } from "../src/routing/expertTuple.js";
import { verifyWorkspaceArtifact } from "../src/routing/codexQualification.js";
import { classifyModelFailure } from "../src/modelCatalog.js";

const qualificationRoot = path.resolve(process.env.PARAGON_QUALIFICATION_ROOT ?? "/tmp/paragon-expert-qualification");
const workspaceRoot = path.join(qualificationRoot, "workspaces");
const evidenceRoot = path.join(qualificationRoot, "evidence");
let qualificationContext = null;

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 2;
}

function assertWorkspace(workspace) {
  const resolved = path.resolve(workspace ?? "");
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`workspace must be registered below ${workspaceRoot}`);
  }
  return resolved;
}

async function registerWorkspace(workspace) {
  const resolved = assertWorkspace(workspace);
  await fs.mkdir(resolved, { recursive: true });
  const marker = path.join(resolved, ".paragon-qualification-workspace.json");
  await fs.writeFile(marker, `${JSON.stringify({ registered: true, workspace: resolved }, null, 2)}\n`);
  return { id: path.basename(resolved), path: resolved, marker };
}

async function filesUnder(root) {
  const result = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result.push(path.relative(root, full));
    }
  }
  await walk(root);
  return result.sort();
}

const chunks = [];
try {
  const input = JSON.parse(await new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  }));
  const expectedMethod = executionMethodFor(input.provider, input.executionMethod === "openai_compatible_http");
  if (input.executionMethod !== expectedMethod) {
    throw new Error(`executionMethod ${input.executionMethod} does not match provider path ${expectedMethod}`);
  }
  const workspace = await registerWorkspace(input.workspace);
  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  qualificationContext = { input, workspace, requestId, startedAt };
  const before = await filesUnder(workspace.path);
  const result = await runProvider(
    input.provider,
    { ...(input.providerConfig ?? {}), model: input.model },
    `The registered disposable workspace is ${workspace.path}. Work only inside that workspace.\n\n${input.prompt ?? "Complete the qualification task."}`,
    (chunk) => chunks.push(String(chunk)),
    {
      cwd: workspace.path,
      toolExecution: true,
      requestBody: input.requestBody
    }
  );
  qualificationContext.executionResult = result;
  const after = await filesUnder(workspace.path);
  let workspaceArtifactVerified = null;
  if (input.expectedFile) {
    try {
      await verifyWorkspaceArtifact({
        workspace: workspace.path,
        relativePath: input.expectedFile,
        expectedContent: input.expectedContent
      });
      workspaceArtifactVerified = true;
    } catch {
      const artifactError = new Error(`workspace artifact verification failed: ${input.expectedFile}`);
      artifactError.code = "WORKSPACE_ARTIFACT_MISSING";
      throw artifactError;
    }
  }
  const evidence = {
    requestId,
    provider: input.provider,
    exactModel: input.model,
    canonicalModelId: input.canonicalModelId ?? input.model,
    reasoningProfile: input.reasoningProfile ?? "unknown",
    executionMethod: input.executionMethod,
    providerCommand: input.providerConfig?.command ?? null,
    nestedOpenHands: false,
    outerToolLoop: input.executionMethod === "openai_compatible_http" ? "not-launched-by-qualification-harness" : "native-cli",
    expertId: input.expertId ?? expertTupleId({
      provider: input.provider,
      canonicalModelId: input.canonicalModelId ?? input.model,
      reasoningProfile: input.reasoningProfile ?? "unknown",
      executionMethod: input.executionMethod
    }),
    workspaceId: workspace.id,
    workspace: workspace.path,
    startedAt,
    completedAt: new Date().toISOString(),
    success: true,
    usage: result.usage ?? null,
    usageUnknown: !result.usage || result.usage.usageUnknown === true,
    toolCalls: result.toolCalls?.length ?? 0,
    filesBefore: before,
    filesAfter: after,
    stdout: result.stdout ?? "",
    streamedOutput: chunks.join(""),
    workspaceArtifactVerified
  };
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(path.join(evidenceRoot, `${requestId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, ...evidence }));
} catch (error) {
  const classification = error?.code === "WORKSPACE_ARTIFACT_MISSING"
    ? "WORKSPACE_ARTIFACT_MISSING"
    : classifyModelFailure(error);
  if (qualificationContext) {
    const { input, workspace, requestId, startedAt } = qualificationContext;
    await fs.mkdir(evidenceRoot, { recursive: true });
    const evidence = {
      requestId,
      provider: input.provider,
      exactModel: input.model,
      canonicalModelId: input.canonicalModelId ?? input.model,
      reasoningProfile: input.reasoningProfile ?? "unknown",
      executionMethod: input.executionMethod,
      expertId: input.expertId ?? expertTupleId({ provider: input.provider, canonicalModelId: input.canonicalModelId ?? input.model, reasoningProfile: input.reasoningProfile ?? "unknown", executionMethod: input.executionMethod }),
      workspaceId: workspace.id,
      workspace: workspace.path,
      startedAt,
      completedAt: new Date().toISOString(),
      success: false,
      failureClassification: classification,
      failure: String(error?.message ?? error),
      providerWide: ["AUTHENTICATION_FAILED", "QUOTA_EXHAUSTED", "ENTITLEMENT_REQUIRED", "PROVIDER_OFFLINE", "CONFIGURATION_ERROR"].includes(classification),
      providerExecutionSucceeded: Boolean(qualificationContext.executionResult)
    };
    await fs.writeFile(path.join(evidenceRoot, `${requestId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ ok: false, ...evidence }));
  } else {
    fail(error?.stack ?? error?.message ?? String(error));
  }
}
