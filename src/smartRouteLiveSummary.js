#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import { readAllDecisions } from "./smartRoute/decisionLog.js";
import { buildLiveSummary, formatLiveSummaryText } from "./smartRoute/liveGuard.js";

const jsonOutput = process.argv.includes("--json");

async function main() {
  const config = await readConfig();
  const decisions = await readAllDecisions();
  const summary = await buildLiveSummary(config, decisions);

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatLiveSummaryText(summary));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
