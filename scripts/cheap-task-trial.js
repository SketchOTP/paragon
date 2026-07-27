#!/usr/bin/env node
/**
 * Cheap-task-only trial (20 requests). Does NOT run automatically — use when ready.
 * Usage: node scripts/cheap-task-trial.js [--limit 20]
 *
 * Preflight: requires valid model-intelligence snapshot and ranked models for
 * chat/rewrite/summarize/extract. Antigravity failure alone does not block the trial.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

import { PROMPTS } from "./cheap-task-trial-prompts.js";
import { readConfig } from "../src/configStore.js";
import { assertPreTrialSnapshotReady } from "../src/smartRoute/preTrialGuard.js";

const limitArg = process.argv.find((_, i, a) => a[i - 1] === "--limit");
const quick = process.argv.includes("--quick");
const limit = quick ? 4 : Number(limitArg ?? 20);
const skipPreflight = process.argv.includes("--skip-preflight");
const skipSnapshotGuard = process.argv.includes("--skip-snapshot-guard");
const maxTokens = Number(
  process.argv.find((_, i, a) => a[i - 1] === "--max-tokens") ?? (quick ? 48 : 256)
);
const baseUrl = process.env.ROUTERBOT_BASE ?? "http://127.0.0.1:4117";
const apiKey = process.env.ROUTERBOT_API_KEY ?? "routerbot";

function runPreflight() {
  const result = spawnSync("node", ["src/smartRouteModelRankings.js", "--preflight"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.status ?? 1;
}

async function main() {
  process.chdir(root);

  if (!skipSnapshotGuard) {
    console.log("Snapshot guard: verifying production intelligence snapshot…");
    const config = await readConfig();
    const guard = await assertPreTrialSnapshotReady(config, { baseUrl, apiKey });
    if (!guard.ok) {
      console.error("\nCheap-task trial aborted by snapshot guard:");
      for (const err of guard.errors) {
        console.error(`  - ${err}`);
      }
      console.error(
        JSON.stringify(
          {
            model_count: guard.model_count,
            intelligence_hash: guard.intelligence_hash,
            research_hash: guard.research_hash,
            refresh_status: guard.refresh_status,
            stale: guard.stale
          },
          null,
          2
        )
      );
      process.exit(2);
    }
    console.log(
      `Snapshot guard OK (${guard.model_count} models, hash ${guard.intelligence_hash?.slice(0, 12)}…)\n`
    );
  }

  if (!skipPreflight) {
    console.log("Preflight: checking model-intelligence snapshot and task floors…");
    const code = runPreflight();
    if (code !== 0) {
      console.error(
        "\nCheap-task trial blocked. Fix snapshot/rankings first (npm run smart-route:model-refresh)."
      );
      console.error("Antigravity failure alone is OK if another model passes floors.");
      process.exit(code);
    }
    console.log("Preflight passed.\n");
  }

  const pool = quick
    ? ["chat", "rewrite", "summarize", "extract"].map((cat) => PROMPTS.find((p) => p.category === cat)).filter(Boolean)
    : PROMPTS;
  const selected = pool.slice(0, Math.min(limit, pool.length));
  console.log(
    `Cheap-task trial: ${selected.length} requests${quick ? " (quick — one per task type)" : ""}, max_tokens=${maxTokens}`
  );
  console.log("Ensure mode=balanced and logging verified before running.\n");

  for (let i = 0; i < selected.length; i += 1) {
    const prompt = selected[i];
    process.stdout.write(`[${i + 1}/${selected.length}] ${prompt.id}... `);
    const started = Date.now();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-RouterBot-Dev": "1"
      },
      body: JSON.stringify({
        model: "routerbot-local",
        messages: [{ role: "user", content: prompt.message }],
        max_tokens: maxTokens,
        stream: false
      })
    });
    const json = await response.json();
    const rb = json.routerbot ?? {};
    console.log(
      response.ok
        ? `${rb.provider ?? "?"} (${Date.now() - started}ms)`
        : `FAIL ${json.error?.message ?? response.status}`
    );
  }
  console.log("\nRun: npm run smart-route:report");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
