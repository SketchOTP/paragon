import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOrchestrationRuntime } from "../src/orchestration/telemetry.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paragon-retention-"));
}

test("runRetentionCompaction removes records older than retentionDays across every store", async () => {
  const dataDir = tmpDir();
  const policy = { retentionDays: 1 };
  const runtime = createOrchestrationRuntime({ dataDir, getPolicy: () => policy });

  const oldNow = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const recentNow = new Date().toISOString();

  await runtime.jobs.getOrCreate("job_old00000000000000000", { repository: null, now: oldNow });
  await runtime.jobs.getOrCreate("job_new00000000000000000", { repository: null, now: recentNow });

  assert.equal(runtime.jobs.all().length, 2);
  const removed = await runtime.runRetentionCompaction();
  assert.ok(removed >= 1, "at least the stale job record should be removed");
  assert.equal(runtime.jobs.all().length, 1);
  assert.ok(runtime.jobs.get("job_new00000000000000000"));
  assert.equal(runtime.jobs.get("job_old00000000000000000"), undefined);
});

test("storageUsageBytes reflects real on-disk file sizes and grows as records are appended", async () => {
  const dataDir = tmpDir();
  const runtime = createOrchestrationRuntime({ dataDir, getPolicy: () => ({ retentionDays: 30 }) });

  const before = runtime.storageUsageBytes();
  await runtime.jobs.getOrCreate("job_size0000000000000000", { repository: "example/repo", now: new Date().toISOString() });
  const after = runtime.storageUsageBytes();
  assert.ok(after > before, "appending a record must increase measured storage usage");
});

test("startRetentionScheduler runs an immediate sweep and can be stopped without throwing", async () => {
  const dataDir = tmpDir();
  const runtime = createOrchestrationRuntime({ dataDir, getPolicy: () => ({ retentionDays: 30 }) });
  runtime.startRetentionScheduler(60000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotThrow(() => runtime.stopRetentionScheduler());
});
