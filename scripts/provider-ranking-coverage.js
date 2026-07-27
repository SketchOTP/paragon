#!/usr/bin/env node
/**
 * Per-provider ranking coverage — no API calls.
 * Shows pricing + health coverage and best ranked model per provider.
 */
import { readConfig } from "../src/configStore.js";
import { readCurrentSnapshot } from "../src/smartRoute/modelSnapshotStore.js";
import {
  rankModelsForTask,
  scoreModelForTask,
  CHEAP_TASK_TRIAL_TYPES,
  pricingStatus
} from "../src/smartRoute/modelRanker.js";
import { resolvePricing, loadPricingOverrides, loadPricingCache } from "../src/smartRoute/modelPricing.js";
import { loadOrFetchPricingCatalog, summarizePricingCoverage } from "../src/smartRoute/modelPricingCatalog.js";
import { summarizeHealthCoverage } from "../src/smartRoute/modelHealthGroups.js";

const json = process.argv.includes("--json");

async function main() {
  const config = await readConfig();
  const snapshot = await readCurrentSnapshot();
  if (!snapshot?.models?.length) {
    console.error("No model-intelligence snapshot. Run: npm run smart-route:model-refresh");
    process.exit(1);
  }

  const enabled = Object.entries(config.providers ?? {})
    .filter(([, c]) => c.enabled !== false)
    .map(([name]) => name);

  const overrides = await loadPricingOverrides();
  const cache = await loadPricingCache();
  const catalog = await loadOrFetchPricingCatalog(config);
  const now = new Date().toISOString();
  const models = snapshot.models.map((row) => ({
    ...row,
    pricing: resolvePricing(row, overrides, cache, config, now, catalog)
  }));

  const pricing_coverage = summarizePricingCoverage(models);
  const health_coverage = summarizeHealthCoverage(models);

  const missingPricing = models
    .filter((m) => pricingStatus(m.pricing) !== "known")
    .slice(0, 10)
    .map((m) => m.canonical_id);

  const missingDirectHealth = models
    .filter((m) => m.health?.health_source !== "direct_probe")
    .slice(0, 10)
    .map((m) => ({
      canonical_id: m.canonical_id,
      health_source: m.health?.health_source ?? "unknown",
      health_confidence: m.health?.health_confidence ?? 0
    }));

  const report = {
    generated_at: snapshot.generated_at,
    refresh_status: snapshot.refresh_status,
    providers: enabled,
    pricing_coverage,
    health_coverage,
    missing_pricing: missingPricing,
    missing_direct_health: missingDirectHealth,
    tasks: {}
  };

  for (const taskType of CHEAP_TASK_TRIAL_TYPES) {
    const key = taskType === "extract" ? "extract_json" : taskType;
    const ranked = rankModelsForTask(models, key, { costSensitive: true });
    const byProvider = {};
    const confidenceBlocked = [];

    for (const provider of enabled) {
      const providerCatalog = models.filter((m) => m.provider === provider);
      const providerRanked = ranked.filter((r) => r.model.provider === provider);
      const best = providerRanked[0];
      const sampleFail = providerCatalog.find(
        (m) => !providerRanked.some((r) => r.model.canonical_id === m.canonical_id)
      );
      let exclusionReason = null;
      if (!best && sampleFail) {
        const scored = scoreModelForTask(sampleFail, key, { costSensitive: true });
        exclusionReason = scored.pass ? "outranked" : scored.reason;
      }

      byProvider[provider] = {
        catalog_count: providerCatalog.length,
        ranked_count: providerRanked.length,
        best: best
          ? {
              canonical_id: best.model.canonical_id,
              score: best.ranking.score,
              effective_cost: best.ranking.effective_cost,
              health_source: best.model.health?.health_source,
              health_confidence: best.model.health?.health_confidence,
              global_rank: ranked.findIndex((r) => r.model.canonical_id === best.model.canonical_id) + 1
            }
          : null,
        sample_exclusion: exclusionReason
      };
    }

    for (const model of models) {
      const scored = scoreModelForTask(model, key, { costSensitive: true });
      if (
        !scored.pass &&
        (scored.reason === "health_confidence_too_low" ||
          scored.reason === "below_min_reliability_health_confidence" ||
          scored.reason === "unknown_health")
      ) {
        confidenceBlocked.push({
          canonical_id: model.canonical_id,
          reason: scored.reason,
          health_source: model.health?.health_source,
          health_confidence: model.health?.health_confidence
        });
      }
    }

    const globalWinner = ranked[0]?.model ?? null;
    report.tasks[taskType] = {
      global_winner: globalWinner?.canonical_id ?? null,
      winner_health_source: globalWinner?.health?.health_source ?? null,
      winner_health_confidence: globalWinner?.health?.health_confidence ?? null,
      floor_blocked_by_health_confidence: !ranked.length,
      confidence_blocked_count: confidenceBlocked.length,
      confidence_blocked_sample: confidenceBlocked.slice(0, 5),
      by_provider: byProvider
    };
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Snapshot: ${snapshot.generated_at} (${snapshot.models.length} models)`);
  console.log(`Refresh status: ${snapshot.refresh_status ?? "unknown"}`);
  console.log(
    `Pricing: known=${pricing_coverage.known}/${pricing_coverage.total} (${pricing_coverage.known_rate})`
  );
  console.log(
    `Health: direct=${health_coverage.direct_probe} inherited=${health_coverage.inherited_group} prior=${health_coverage.prior_snapshot} unknown=${health_coverage.unknown}`
  );
  if (missingPricing.length) {
    console.log(`Missing pricing (sample): ${missingPricing.join(", ")}`);
  }
  console.log("");

  for (const [task, data] of Object.entries(report.tasks)) {
    console.log(`=== ${task} ===`);
    console.log(
      `  global winner: ${data.global_winner ?? "none"}` +
        (data.winner_health_source
          ? ` [${data.winner_health_source} conf=${data.winner_health_confidence}]`
          : "")
    );
    if (data.floor_blocked_by_health_confidence) {
      console.log(`  FLOOR BLOCKED by health confidence (${data.confidence_blocked_count} models)`);
    }
    for (const [provider, row] of Object.entries(data.by_provider)) {
      if (row.best) {
        console.log(
          `  ${provider}: #${row.best.global_rank} ${row.best.canonical_id} score=${row.best.score.toFixed(2)} cost=${row.best.effective_cost} health=${row.best.health_source}`
        );
      } else {
        console.log(
          `  ${provider}: NOT RANKED (${row.catalog_count} catalog, reason: ${row.sample_exclusion ?? "n/a"})`
        );
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
