#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import { runModelIntelligenceRefresh } from "./smartRoute/modelIntelligenceRefresh.js";

const config = await readConfig();
const quick = process.argv.includes("--quick");
const probePrimaryOnly = process.argv.includes("--probe-primary-only")
  ? true
  : process.argv.includes("--probe-all")
    ? false
    : undefined;

const result = await runModelIntelligenceRefresh(config, {
  quick,
  probe: !quick,
  probePrimaryOnly
});

if (result.ok) {
  console.log(
    JSON.stringify(
      {
        status: "ok",
        model_count: result.snapshot.models.length,
        generated_at: result.snapshot.generated_at,
        probe_primary_only: result.snapshot.probe_primary_only,
        pricing_coverage: result.snapshot.pricing_coverage,
        health_coverage: result.snapshot.health_coverage,
        health_meta: result.snapshot.health_meta,
        changes: result.changes
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.error(JSON.stringify(result, null, 2));
process.exit(result.partial ? 2 : 1);
