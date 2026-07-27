#!/usr/bin/env node
/**
 * Post-mismatch-fix cheap-task trial orchestrator.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAllDecisions } from "../src/smartRoute/decisionLog.js";
import { loadModelRegistry } from "../src/smartRoute/registry.js";
import { aggregateExecutionRates, buildShadowReport } from "../src/smartRoute/shadowReport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const logPath = path.join(root, "data/smart-route-log.jsonl");
const configPath = path.join(root, "data/config.json");
const baseUrl = process.env.ROUTERBOT_BASE ?? "http://127.0.0.1:4117";
const apiKey = process.env.PARAGON_API_KEY ?? process.env.ROUTERBOT_API_KEY ?? "paragon";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function readConfig() {
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

async function writeConfig(config) {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function pushConfig(config) {
  const response = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(config)
  });
  if (!response.ok) {
    throw new Error(`Config push failed: ${response.status}`);
  }
}

async function setMode(mode) {
  const config = await readConfig();
  config.routing.smartRoute.mode = mode;
  await writeConfig(config);
  await pushConfig(config);
  return mode;
}

function bump(map, key) {
  const k = key ?? "unknown";
  map[k] = (map[k] ?? 0) + 1;
}

async function analyzeTrial() {
  const all = await readAllDecisions();
  const trial = all.filter((row) => row.mode === "balanced");
  const registry = await loadModelRegistry(await readConfig());
  const report = buildShadowReport(trial, registry);
  const rates = aggregateExecutionRates(trial, registry);

  const byTask = {};
  const byRankingWinner = {};
  const bySelectedCanonical = {};
  const byFinalCanonical = {};
  const byOverrideSource = {};
  const byOverrideReason = {};
  let httpSuccess = 0;
  let httpFail = 0;
  let mismatchCount = 0;
  let nonFallbackMismatches = [];

  for (const row of trial) {
    bump(byTask, row.task_type);
    bump(byRankingWinner, row.ranking_winner_canonical_id);
    bump(bySelectedCanonical, row.selected_canonical_id);
    bump(byFinalCanonical, row.final_executed_canonical_id);
    if (row.override_source) bump(byOverrideSource, row.override_source);
    if (row.override_reason) bump(byOverrideReason, row.override_reason);
    if (row.execution_mismatch) {
      mismatchCount += 1;
      if (!row.total_fallback_used && !row.execution_failed) {
        nonFallbackMismatches.push({
          request_id: row.request_id,
          ranking_winner: row.ranking_winner_canonical_id,
          final: row.final_executed_canonical_id,
          mismatch_reason: row.mismatch_reason
        });
      }
    }
    if (row.execution_failed || row.success === false) {
      httpFail += 1;
    } else {
      httpSuccess += 1;
    }
  }

  const legacyOverrides = trial.filter(
    (r) =>
      r.override_source &&
      !["safe_cheap_filter_advisory", "executor_map"].includes(r.override_source) &&
      r.uses_model_intelligence
  );
  const antigravityOverrides = trial.filter(
    (r) =>
      r.gate_reason?.includes("safe_cheap_antigravity") ||
      r.override_reason?.includes("antigravity")
  );

  const pass =
    mismatchCount === 0 &&
    nonFallbackMismatches.length === 0 &&
    httpSuccess / Math.max(trial.length, 1) >= 0.95 &&
    rates.validation_failure_rate < 0.1 &&
    rates.provider_fallback_rate < 0.2 &&
    rates.quality_escalation_rate < 0.1 &&
    legacyOverrides.length === 0 &&
    antigravityOverrides.length === 0;

  return {
    pass,
    total_requests: trial.length,
    http_success: httpSuccess,
    http_failure: httpFail,
    task_type_breakdown: byTask,
    ranking_winner_canonical_id_breakdown: byRankingWinner,
    selected_canonical_id_breakdown: bySelectedCanonical,
    final_executed_canonical_id_breakdown: byFinalCanonical,
    execution_mismatch_count: mismatchCount,
    non_fallback_mismatches: nonFallbackMismatches,
    override_source_breakdown: byOverrideSource,
    override_reason_breakdown: byOverrideReason,
    provider_fallback_rate: rates.provider_fallback_rate,
    quality_escalation_rate: rates.quality_escalation_rate,
    validation_failure_rate: rates.validation_failure_rate,
    execution_mismatch_rate: rates.execution_mismatch_rate,
    actual_cost_after_fallback_usd: report.actual_cost_after_fallback_usd,
    estimated_savings_after_fallback_usd: report.estimated_savings_after_fallback_usd,
    legacy_override_rows: legacyOverrides.length,
    antigravity_override_rows: antigravityOverrides.length,
    all_non_fallback_matched:
      nonFallbackMismatches.length === 0 &&
      trial
        .filter((r) => !r.total_fallback_used && !r.execution_failed && r.ranking_winner_canonical_id)
        .every((r) => r.final_executed_canonical_id === r.ranking_winner_canonical_id)
  };
}

async function main() {
  process.chdir(root);

  let config = await readConfig();
  const startMode = config.routing?.smartRoute?.mode ?? "shadow_test";
  console.log(`\n=== Pre-check 1: mode ===`);
  if (startMode !== "shadow_test") {
    console.log(`Mode was ${startMode}, setting shadow_test for pre-checks...`);
    await setMode("shadow_test");
    startMode !== "shadow_test" && console.log("Set to shadow_test");
  } else {
    console.log(`OK: mode is shadow_test`);
  }

  console.log(`\n=== Pre-check 2: preflight ===`);
  await run("npm", ["run", "smart-route:model-rankings:preflight"]);

  console.log(`\n=== Pre-check 3: trace-selection ===`);
  await run("npm", ["run", "smart-route:trace-selection", "--", "--prompt", "rewrite this: hello world"]);

  console.log(`\n=== Pre-check 4: archive logs ===`);
  const archivePath = path.join(
    root,
    `data/smart-route-log-archive-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  try {
    await fs.copyFile(logPath, archivePath);
    console.log(`Archived → ${path.basename(archivePath)}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log("No prior log to archive");
  }
  await fs.writeFile(logPath, "", "utf8");
  console.log("Cleared log for isolated trial\n");

  console.log(`=== Trial: balanced mode ===`);
  await setMode("balanced");
  await run("node", ["scripts/cheap-task-trial.js", "--quick", "--skip-preflight"]);

  console.log(`\n=== Revert to shadow_test ===`);
  await setMode("shadow_test");

  console.log(`\n=== Reports ===\n`);
  await run("npm", ["run", "smart-route:report"]);
  console.log("");
  await run("npm", ["run", "smart-route:report:json"]);

  const analysis = await analyzeTrial();
  const summaryPath = path.join(root, "data/smart-route-cheap-task-trial-post-fix.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(analysis, null, 2)}\n`);

  console.log(`\n=== Trial Analysis ===\n`);
  console.log(JSON.stringify(analysis, null, 2));
  console.log(`\nResult: ${analysis.pass ? "PASS" : "FAIL"}`);
  console.log(`Summary: ${summaryPath}`);

  if (!analysis.pass) {
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error("\nFATAL:", error.message);
  try {
    await setMode("shadow_test");
  } catch {
    // ignore
  }
  process.exit(1);
});
