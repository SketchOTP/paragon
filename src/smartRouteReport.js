#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import { readAllDecisions } from "./smartRoute/decisionLog.js";
import { loadModelRegistry } from "./smartRoute/registry.js";
import { buildFullShadowReport } from "./smartRoute/report.js";
import { formatReportText } from "./smartRoute/shadowReport.js";

const jsonOutput = process.argv.includes("--json");

async function main() {
  const config = await readConfig();
  const registry = await loadModelRegistry(config);
  const decisions = await readAllDecisions();
  const report = await buildFullShadowReport(decisions, registry, config);

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatReportText(report));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
