#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import { runResearchRefresh } from "./smartRoute/researchAgent/researchRefresh.js";

const config = await readConfig();
const result = await runResearchRefresh(config);

if (result.ok) {
  console.log(
    JSON.stringify(
      {
        status: "ok",
        research_hash: result.catalog.research_hash,
        generated_at: result.catalog.generated_at,
        coverage: result.coverage,
        price_changes: result.catalog.price_changes?.length ?? 0,
        source_failures: result.catalog.source_failures?.length ?? 0
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.error(JSON.stringify(result, null, 2));
process.exit(result.partial ? 2 : 1);
