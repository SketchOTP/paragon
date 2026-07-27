#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import {
  readCurrentSnapshot,
  snapshotUsable,
  canUseSnapshotForActiveMode
} from "./smartRoute/modelSnapshotStore.js";
import {
  rankAllTasks,
  checkCheapTaskTrialReadiness,
  buildPreflightDiagnostics
} from "./smartRoute/modelRanker.js";

const config = await readConfig();
const snapshot = await readCurrentSnapshot();
const preflight = process.argv.includes("--preflight");

if (!snapshot?.models?.length) {
  console.error(
    JSON.stringify({ error: "No model intelligence snapshot. Run npm run smart-route:model-refresh first." })
  );
  process.exit(1);
}

const rankOptions = {
  mode: "balanced",
  smartRoute: { ...(config.routing?.smartRoute ?? {}), mode: "balanced" },
  config,
  costSensitive: true,
  complexity: 1,
  risk: 1
};
const rankings = rankAllTasks(snapshot.models, undefined, rankOptions);
const gate = canUseSnapshotForActiveMode(config, snapshot);
const readiness = checkCheapTaskTrialReadiness(rankings);
const diagnostics = buildPreflightDiagnostics(snapshot.models, undefined, {
  snapshotGeneratedAt: snapshot.generated_at,
  ...rankOptions
});

const payload = {
  generated_at: snapshot.generated_at,
  refresh_status: snapshot.refresh_status ?? null,
  refresh_duration_ms: snapshot.refresh_duration_ms ?? null,
  stale: !snapshotUsable(snapshot, config),
  snapshot_gate: gate,
  readiness,
  preflight_diagnostics: diagnostics,
  rankings
};

console.log(JSON.stringify(payload, null, 2));

if (preflight) {
  if (!gate.allowed) {
    console.error("BLOCKED: model intelligence snapshot missing or stale");
    process.exit(2);
  }
  if (!readiness.ready) {
    console.error(`BLOCKED: no model passes floors for: ${readiness.missing.join(", ")}`);
    for (const row of diagnostics.per_task.filter((t) => !t.passes)) {
      console.error(
        `\n[${row.task_type}] floor=${JSON.stringify(row.required_floor)} ` +
          `dominant=${row.issue_summary.dominant_issue ?? "?"} ` +
          `best=${row.best_candidate?.canonical_id ?? "none"} ` +
          `reason=${row.why_best_failed?.exclusion_reason ?? row.why_best_failed?.message ?? "?"}`
      );
      for (const ex of row.top_excluded.slice(0, 3)) {
        console.error(
          `  excluded: ${ex.canonical_id} | ${ex.exclusion_reason} | rel=${ex.reliability} qual=${ex.quality} ` +
            `cost=${ex.effective_cost} | health=${ex.health_failure_category ?? "-"} | pricing=${ex.pricing_status}`
        );
      }
    }
    process.exit(3);
  }
  process.exit(0);
}
