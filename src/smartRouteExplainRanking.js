#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import { readCurrentSnapshot } from "./smartRoute/modelSnapshotStore.js";
import { explainRanking } from "./smartRoute/modelRanker.js";
import { extractFeatures } from "./smartRoute/features.js";
import { normalizeRequest } from "./smartRoute/normalize.js";
import { cheapStaticDecision } from "./smartRoute/features.js";
import { applyTaskTypeHint, inferTaskTypeFromPrompt } from "./smartRoute/taskHints.js";

function parseArgs(argv) {
  const taskIdx = argv.indexOf("--task");
  const promptIdx = argv.indexOf("--prompt");
  const modeIdx = argv.indexOf("--mode");
  const task = taskIdx >= 0 ? argv[taskIdx + 1] : null;
  const prompt =
    promptIdx >= 0 && argv[promptIdx + 1]
      ? argv[promptIdx + 1]
      : "rewrite this professionally: hey send me the file";
  const mode = modeIdx >= 0 ? argv[modeIdx + 1] : "balanced";
  const json = argv.includes("--json");
  return { task, prompt, mode, json };
}

function formatExplain(report) {
  const lines = [
    `task_type: ${report.task_type}`,
    `mode: ${report.mode}`,
    `selection_strategy: ${report.selection_strategy}`,
    `winner_reason: ${report.winner_reason}`,
    `winner: ${report.winner_canonical_id ?? "none"}`,
    `quality_floor: ${report.quality_floor}`,
    `reliability_floor: ${report.reliability_floor}`,
    `min_pricing_confidence: ${report.min_pricing_confidence}`,
    `winner_quality: ${report.winner_quality}`,
    `winner_effective_cost: ${report.winner_effective_cost}`,
    `premium_blocked: ${report.premium_blocked}`,
    `premium_block_reason: ${report.premium_block_reason ?? "none"}`,
    "",
    "passed_floor (cheapest first):"
  ];

  for (const row of report.passed_floor.slice(0, 12)) {
    lines.push(
      `  ${row.canonical_id} cost=${row.effective_cost} quality=${row.task_quality} rel=${row.reliability} premium=${row.is_premium} price_conf=${row.pricing_confidence} src=${row.pricing_evidence?.source_url ?? "none"}`
    );
  }

  if (report.runner_ups.length) {
    lines.push("", "premium_blocked_runner_ups:");
    for (const row of report.runner_ups.slice(0, 8)) {
      lines.push(
        `  ${row.canonical_id} cost=${row.effective_cost} quality=${row.task_quality} reason=${row.excluded_reason}`
      );
    }
  }

  if (report.excluded.length) {
    lines.push("", "excluded (sample):");
    for (const row of report.excluded.slice(0, 12)) {
      lines.push(`  ${row.canonical_id} | ${row.excluded_reason}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const { task, prompt, mode, json } = parseArgs(process.argv.slice(2));
  const config = await readConfig();
  const snapshot = await readCurrentSnapshot();
  if (!snapshot?.models?.length) {
    console.error("No model intelligence snapshot. Run model-refresh first.");
    process.exit(1);
  }

  const body = {
    model: config?.server?.exposedModel ?? "routerbot-local",
    messages: [{ role: "user", content: prompt }]
  };
  const normalized = normalizeRequest(body, {}, config);
  const features = extractFeatures(normalized);
  let classifier = cheapStaticDecision(features);
  if (inferTaskTypeFromPrompt(prompt)) {
    classifier = applyTaskTypeHint(classifier, prompt);
  }
  const taskType = task ?? classifier.task_type ?? "chat";

  const report = explainRanking(snapshot.models, taskType, {
    mode,
    smartRoute: { ...(config.routing?.smartRoute ?? {}), mode },
    config,
    complexity: classifier.complexity ?? 1,
    risk: classifier.risk ?? 1,
    requiresTools: features.requiresTools,
    requiresVision: features.hasImage,
    requiresStrictJson: features.requiresStrictJson || taskType === "extract_json",
    costSensitive: true
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatExplain(report));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
