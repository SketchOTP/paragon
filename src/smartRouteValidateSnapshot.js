#!/usr/bin/env node
/**
 * Validate model-intelligence + research catalogs before live trials.
 */
import { readConfig } from "./configStore.js";
import { readCurrentSnapshot } from "./smartRoute/modelSnapshotStore.js";
import { loadResearchCatalog, summarizeResearchCoverage } from "./smartRoute/researchAgent/researchCatalog.js";
import { hasKnownPricing } from "./smartRoute/modelPricing.js";
import { rankModelsForTask, CHEAP_TASK_TRIAL_TYPES } from "./smartRoute/modelRanker.js";

const config = await readConfig();
const snapshot = await readCurrentSnapshot();
const research = await loadResearchCatalog();

const errors = [];
const warnings = [];

if (!snapshot?.models?.length) {
  errors.push("missing_model_intelligence_snapshot");
}
if (!research?.pricing?.length) {
  errors.push("missing_research_catalog");
}
if (snapshot?.research_hash && research?.research_hash && snapshot.research_hash !== research.research_hash) {
  warnings.push("research_hash_mismatch_between_intelligence_and_research");
}

const models = snapshot?.models ?? [];
const activeCandidates = [];
for (const taskType of CHEAP_TASK_TRIAL_TYPES) {
  const key = taskType === "extract" ? "extract_json" : taskType;
  const ranked = rankModelsForTask(models, key, { costSensitive: true });
  if (ranked[0]) activeCandidates.push(ranked[0].model);
}

const uniqueCandidates = [...new Map(activeCandidates.map((m) => [m.canonical_id, m])).values()];
let evidenceOk = 0;
let invalidWinner = false;

for (const model of uniqueCandidates) {
  const pricing = model.pricing ?? {};
  if (pricing.pricing_status === "invalid") {
    invalidWinner = true;
    errors.push(`invalid_pricing_winner:${model.canonical_id}`);
  }
  if (hasKnownPricing(pricing) && pricing.source_url) {
    evidenceOk += 1;
  } else if (hasKnownPricing(pricing)) {
    warnings.push(`winner_missing_source_url:${model.canonical_id}`);
    evidenceOk += 1;
  } else {
    errors.push(`winner_not_cost_sensitive_eligible:${model.canonical_id}`);
  }
}

const coverage = summarizeResearchCoverage(research);
const candidateCoverage = uniqueCandidates.length ? evidenceOk / uniqueCandidates.length : 0;

if (candidateCoverage < 0.95 && uniqueCandidates.length) {
  errors.push(`pricing_evidence_coverage_below_95:${candidateCoverage}`);
}

const report = {
  ok: errors.length === 0,
  intelligence_hash: snapshot?.intelligence_hash ?? null,
  research_hash: research?.research_hash ?? snapshot?.research_hash ?? null,
  research_coverage: coverage,
  active_candidate_count: uniqueCandidates.length,
  active_candidate_evidence_rate: candidateCoverage,
  invalid_winner: invalidWinner,
  winners: uniqueCandidates.map((m) => ({
    canonical_id: m.canonical_id,
    pricing_status: m.pricing?.pricing_status,
    source_url: m.pricing?.source_url,
    cost_sensitive_eligible: m.pricing?.cost_sensitive_eligible
  })),
  errors,
  warnings
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
