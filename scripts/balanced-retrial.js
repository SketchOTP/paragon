#!/usr/bin/env node
/**
 * Clean Balanced re-trial orchestrator: archive logs, pre-check, flip balanced, run trial, revert, report.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAllDecisions } from "../src/smartRoute/decisionLog.js";
import { loadModelRegistry } from "../src/smartRoute/registry.js";
import {
  buildShadowReport,
  detectDangerDowngrade,
  enrichDecision,
  aggregateExecutionRates
} from "../src/smartRoute/shadowReport.js";
import { isSafeCheapTask, mergeSafeCheapTasks, isPremiumProvider } from "../src/smartRoute/safeCheapTasks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const logPath = path.join(root, "data/smart-route-log.jsonl");
const configPath = path.join(root, "data/config.json");
const baseUrl = process.env.ROUTERBOT_BASE ?? "http://127.0.0.1:4117";
const apiKey = process.env.PARAGON_API_KEY ?? process.env.ROUTERBOT_API_KEY ?? "paragon";
const TRIAL_LIMIT = Number(process.env.TRIAL_LIMIT ?? 33);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
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

async function sendTest(message) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-RouterBot-Dev": "1"
    },
    body: JSON.stringify({
      model: "paragon",
      messages: [{ role: "user", content: message }],
      max_tokens: 20,
      stream: false
    })
  });
  const json = await response.json();
  return { ok: response.ok, paragon: json.paragon ?? null };
}

async function countLogLines() {
  try {
    const raw = await fs.readFile(logPath, "utf8");
    return raw.trim() ? raw.trim().split("\n").length : 0;
  } catch {
    return 0;
  }
}

async function readTrialDecisions() {
  const raw = await fs.readFile(logPath, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line)).filter((row) => row.mode === "balanced");
}

function shouldAbortEarly(metrics) {
  if (!metrics || metrics.total < 8) {
    return false;
  }
  if (metrics.premium_fallback_on_cheap_tasks_rate > 0.1) {
    return "premium_fallback_on_cheap_tasks_critical";
  }
  if (metrics.provider_fallback_rate > 0.25) {
    return "provider_fallback_rate_critical";
  }
  if (metrics.quality_escalation_rate > 0.2) {
    return "quality_escalation_rate_critical";
  }
  if (metrics.total_fallback_rate > 0.4) {
    return "total_fallback_rate_critical";
  }
  if (metrics.validation_failure_rate > 0.25) {
    return "validation_failure_rate_critical";
  }
  if (metrics.danger_downgrades > 0) {
    return "danger_downgrade_detected";
  }
  return null;
}

async function checkpointMetrics() {
  const registry = await loadModelRegistry(await readConfig());
  const rows = await readTrialDecisions();
  const enriched = rows.map((row) => enrichDecision(row, registry));
  const rates = aggregateExecutionRates(enriched, registry);
  const danger = enriched.filter((r) => detectDangerDowngrade(r).danger).length;
  return {
    total: enriched.length,
    ...rates,
    validation_failure_rate:
      enriched.filter((r) => r.validator_result === "fail").length / Math.max(enriched.length, 1),
    danger_downgrades: danger
  };
}

async function analyzeReport() {
  const all = await readAllDecisions();
  const trial = all.filter((row) => row.mode === "balanced");
  const registry = await loadModelRegistry(await readConfig());
  const report = buildShadowReport(trial, registry);

  const bySmart = {};
  const bySelected = {};
  const validatorCategories = {};
  let successCount = 0;

  for (const row of trial) {
    bump(bySmart, row.smart_provider);
    bump(bySelected, row.selected_provider);
    if (row.success !== false) {
      successCount += 1;
    }
    if (row.validator_failure_category) {
      bump(validatorCategories, row.validator_failure_category);
    }
  }

  const fallbackRate =
    trial.filter((r) => r.fallback_used).length / Math.max(trial.length, 1);
  const validationFailRate =
    trial.filter((r) => r.validator_result === "fail").length / Math.max(trial.length, 1);

  const hardDanger = report.danger_cases.filter((c) =>
    ["architecture", "research", "code_debug", "high_stakes"].includes(c.task_type)
  );

  const simpleTasks = trial.filter((r) =>
    ["chat", "rewrite", "summarize", "extract"].includes(r.task_type)
  );
  const simpleOnAntigravity = simpleTasks.filter((r) => r.selected_provider === "antigravity").length;
  const simpleAntigravityRate = simpleTasks.length ? simpleOnAntigravity / simpleTasks.length : 0;

  const premiumViolations = trial.filter(
    (r) =>
      (r.task_type === "architecture" ||
        r.task_type === "high_stakes" ||
        (r.risk ?? 0) >= 4) &&
      r.smart_tier &&
      r.smart_tier !== "premium"
  );

  const passed =
    fallbackRate < 0.2 &&
    validationFailRate < 0.1 &&
    (report.estimated_savings_after_fallback_usd ?? 0) > 0 &&
    hardDanger.length === 0 &&
    premiumViolations.length === 0;

  return {
    report,
    trial_count: trial.length,
    success_count: successCount,
    fallback_rate: fallbackRate,
    validation_failure_rate: validationFailRate,
    danger_downgrades: report.danger_downgrades,
    hard_danger_cases: hardDanger,
    actual_cost_after_fallback_usd: report.actual_cost_after_fallback_usd,
    estimated_savings_after_fallback_usd: report.estimated_savings_after_fallback_usd,
    by_smart_provider: bySmart,
    by_selected_provider: bySelected,
    validator_failure_categories: validatorCategories,
    simple_task_antigravity_rate: simpleAntigravityRate,
    premium_violations: premiumViolations.length,
    passed
  };
}

function bump(map, key) {
  const k = key ?? "unknown";
  map[k] = (map[k] ?? 0) + 1;
}

async function setMode(mode) {
  const config = await readConfig();
  config.routing.smartRoute.mode = mode;
  await writeConfig(config);
  await pushConfig(config);
  return mode;
}

async function main() {
  process.chdir(root);
  console.log("=== SmartRoute Balanced Re-trial ===\n");

  const serverPid = await new Promise((resolve) => {
    const child = spawn("pgrep", ["-f", path.join(root, "src/server.js")], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", () => resolve(out.trim().split("\n").filter(Boolean)[0] ?? "unknown"));
  });
  console.log(`Server PID: ${serverPid}`);

  const config = await readConfig();
  const startMode = config.routing?.smartRoute?.mode ?? "shadow_test";
  if (startMode !== "shadow_test") {
    throw new Error(`Expected shadow_test before trial, got ${startMode}`);
  }
  console.log(`Pre-check mode: ${startMode}`);

  const archivePath = path.join(
    root,
    `data/smart-route-log-archive-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
  );
  try {
    await fs.copyFile(logPath, archivePath);
    console.log(`Archived log → ${path.basename(archivePath)}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    console.log("No prior log to archive");
  }
  await fs.writeFile(logPath, "", "utf8");

  const beforeLines = await countLogLines();
  const pre = await sendTest("Reply exactly: balanced-precheck-ok");
  const afterPre = await countLogLines();
  if (afterPre <= beforeLines) {
    throw new Error("Pre-check failed: no new log entry written");
  }
  console.log(`Pre-check OK: log ${beforeLines} → ${afterPre}, routed=${pre.paragon?.routedProvider}`);

  await fs.writeFile(logPath, "", "utf8");
  console.log("Cleared pre-check entries; starting isolated balanced trial log\n");

  await setMode("balanced");
  console.log("Switched to balanced mode\n");

  let aborted = false;
  let abortReason = null;

  const trialScript = path.join(root, "scripts/smart-route-trial.js");
  const trialResultsPath = path.join(root, "data/smart-route-trial-results-balanced.jsonl");
  await fs.writeFile(trialResultsPath, "", "utf8").catch(() => {});

  const prompts = TRIAL_LIMIT;
  const child = spawn("node", [trialScript, "--limit", String(prompts)], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"]
  });

  let buffer = "";
  child.stdout.on("data", async (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk.toString();
    const matches = buffer.match(/\[(\d+)\/(\d+)\]/g);
    if (!matches?.length) {
      return;
    }
    const last = matches[matches.length - 1];
    const n = Number(last.match(/\[(\d+)/)[1]);
    if (n % 5 === 0) {
      try {
        const metrics = await checkpointMetrics();
        const reason = shouldAbortEarly(metrics);
        if (reason) {
          aborted = true;
          abortReason = reason;
          console.log(`\n*** EARLY ABORT: ${reason} ***`);
          console.log(JSON.stringify(metrics, null, 2));
          child.kill("SIGTERM");
        }
      } catch {
        // ignore checkpoint read errors during trial
      }
    }
  });

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (aborted) {
        resolve();
        return;
      }
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Trial exited ${code}`));
      }
    });
  });

  console.log("\nReverting to shadow_test...");
  await setMode("shadow_test");

  console.log("\n=== Reports ===\n");
  await run("npm", ["run", "smart-route:report"]);
  console.log("");
  await run("npm", ["run", "smart-route:report:json"]);

  const analysis = await analyzeReport();
  const summaryPath = path.join(root, "data/smart-route-balanced-retrial-summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify({ aborted, abortReason, ...analysis }, null, 2)}\n`);

  console.log("\n=== Trial Summary ===");
  console.log(JSON.stringify(analysis, null, 2));
  console.log(`\nBalanced trial: ${analysis.passed ? "PASS" : "FAIL"}${aborted ? ` (aborted: ${abortReason})` : ""}`);
  console.log(`Summary saved: ${summaryPath}`);
}

main().catch(async (error) => {
  console.error("\nFATAL:", error.message);
  try {
    await setMode("shadow_test");
    console.error("Reverted to shadow_test after failure");
  } catch {
    // ignore
  }
  process.exit(1);
});
