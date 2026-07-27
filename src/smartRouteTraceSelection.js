#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import { traceSelection, formatTraceReport } from "./smartRoute/traceSelection.js";

function parseArgs(argv) {
  const promptIdx = argv.indexOf("--prompt");
  const prompt =
    promptIdx >= 0 && argv[promptIdx + 1]
      ? argv[promptIdx + 1]
      : argv.filter((a) => !a.startsWith("-")).join(" ") || "rewrite this: hello world";
  const json = argv.includes("--json");
  return { prompt, json };
}

async function main() {
  const { prompt, json } = parseArgs(process.argv.slice(2));
  const config = await readConfig();
  const trace = await traceSelection(prompt, config);
  if (json) {
    console.log(JSON.stringify(trace, null, 2));
  } else {
    console.log(formatTraceReport(trace));
  }
  if (trace.uses_model_intelligence && trace.ranking_winner && trace.selected_canonical_id !== trace.ranking_winner) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
