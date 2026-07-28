/**
 * Deterministic candidate scoring (PARAGON-D-004). Replaces "task type ->
 * fixed provider" as the actual live decision: this resolves provider AND
 * model together, filtered by real eligibility (health, circuit state,
 * context fit, automatic-eligibility) and scored by task-type cost/latency
 * preference plus the operator's existing taskRoutes as a strong signal —
 * not an absolute override.
 *
 * No LLM call is used to make this decision — it's pure deterministic
 * scoring over the model registry, per D-004's explicit "use deterministic
 * policy for normal decisions" requirement.
 */

import { buildModelRegistry } from "./modelRegistry.js";
import { annotateRegistryWithBenchmarks } from "./benchmarks.js";
import { isCircuitOpen, circuitStateSnapshot } from "../orchestration/liveEnforcement.js";

// "good enough" threshold for the value-scoring stage below: a candidate
// within this fraction of the best available external benchmark index for
// a task is treated as capable of doing the job, not just the top scorer.
const QUALITY_FLOOR_RATIO = 0.85;
const CODING_TASK_TYPES = new Set(["code", "debug", "review"]);

// Coarse per-task-type cost/latency preference. Not a learned weighting —
// an explicit, readable starting policy an operator can see and override
// via routing.taskRoutes (still respected as a strong preferred-provider
// signal, scored in below rather than hard-forced).
const TASK_COST_PREFERENCE = {
  quick: "economy",
  explain: "economy",
  docs: "standard",
  code: "standard",
  debug: "premium",
  review: "premium",
  plan: "premium"
};

const WEIGHTS = {
  taskRoutePreference: 3,
  costClassMatch: 2,
  costClassMismatch: -1,
  healthy: 2,
  healthUnknown: 0,
  contextFit: 1,
  contextMissingWhenNeeded: -3,
  circuitHalfOpen: -1,
  // Value-scoring stage (only applied when a candidate has a matched
  // external benchmark — see applyValueScoring below). Deliberately larger
  // than the internal-only weights above: once real quality+price data
  // exists for a candidate, it should dominate the coarse cost-class
  // heuristic, not just nudge it.
  valueBonusMax: 8,
  valueFloorPenalty: -4
};

function passesHardEligibility(entry, { estimatedInputTokens }) {
  if (!entry.automaticEligibility) {
    return { ok: false, reasonCode: "eligibility.automaticEligibilityDisabled" };
  }
  if (entry.health === "unhealthy") {
    return { ok: false, reasonCode: "eligibility.unhealthyProvider" };
  }
  if (isCircuitOpen(entry.provider)) {
    return { ok: false, reasonCode: "eligibility.circuitOpen" };
  }
  if (entry.contextWindow != null && estimatedInputTokens != null && estimatedInputTokens > entry.contextWindow) {
    return { ok: false, reasonCode: "eligibility.contextWindowExceeded" };
  }
  return { ok: true };
}

function scoreCandidate(entry, taskProfile, taskRoutes) {
  let score = 0;
  const reasons = [];

  const preferredProvider = taskRoutes?.[taskProfile.taskType];
  if (preferredProvider && preferredProvider === entry.provider) {
    score += WEIGHTS.taskRoutePreference;
    reasons.push("configured task-route preference");
  }

  const preferredCost = TASK_COST_PREFERENCE[taskProfile.taskType];
  if (preferredCost) {
    if (entry.costClass === preferredCost) {
      score += WEIGHTS.costClassMatch;
      reasons.push(`cost class ${entry.costClass} matches ${taskProfile.taskType} preference`);
    } else if (
      (preferredCost === "economy" && entry.costClass === "premium") ||
      (preferredCost === "premium" && entry.costClass === "economy")
    ) {
      score += WEIGHTS.costClassMismatch;
      reasons.push(`cost class ${entry.costClass} is a poor fit for ${taskProfile.taskType}`);
    }
  }

  if (entry.health === "healthy") {
    score += WEIGHTS.healthy;
    reasons.push("provider healthy");
  } else if (entry.health === "unknown") {
    score += WEIGHTS.healthUnknown;
  }

  if (taskProfile.estimatedInputTokens != null) {
    if (entry.contextWindow != null && entry.contextWindow >= taskProfile.estimatedInputTokens * 1.2) {
      score += WEIGHTS.contextFit;
      reasons.push("comfortable context headroom");
    } else if (entry.contextWindow == null && taskProfile.estimatedInputTokens > 50000) {
      score += WEIGHTS.contextMissingWhenNeeded;
      reasons.push("context window unknown for a large request — penalized, not excluded");
    }
  }

  if (circuitStateSnapshot()[entry.provider] === "half-open") {
    score += WEIGHTS.circuitHalfOpen;
    reasons.push("provider circuit half-open (recovering)");
  }

  return { score, reasons };
}

/** codingIndex is the more relevant Artificial Analysis metric for coding-flavored task types; intelligenceIndex is the general fallback. */
function benchmarkIndexForTask(entry, taskType) {
  const b = entry.externalBenchmark;
  if (!b) {
    return null;
  }
  const value = CODING_TASK_TYPES.has(taskType) ? (b.codingIndex ?? b.intelligenceIndex) : (b.intelligenceIndex ?? b.codingIndex);
  return value ?? null;
}

function benchmarkPromptPrice(entry) {
  const raw = entry.externalBenchmark?.pricing?.prompt;
  const value = raw == null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The actual "good enough for the cost" algorithm (PARAGON-D-004 follow-up):
 * among eligible candidates that have a matched external benchmark, find
 * the best available quality index for this task, then treat every
 * candidate within QUALITY_FLOOR_RATIO of it as capable of doing the job.
 * Within that "good enough" set, cheaper wins — reward is inversely
 * proportional to price, not to raw quality. Candidates below the floor
 * are deprioritized (not excluded — they may still be the only option).
 * Candidates with no benchmark match are untouched: this stage never
 * penalizes or favors a model just for lacking external data, it only
 * acts on real data when present.
 */
function applyValueScoring(eligibleCandidates, taskType) {
  const withBenchmark = eligibleCandidates
    .map((c) => ({ c, index: benchmarkIndexForTask(c.entry, taskType), price: benchmarkPromptPrice(c.entry) }))
    .filter((x) => x.index != null && x.price != null);

  if (!withBenchmark.length) {
    return;
  }

  const maxIndex = Math.max(...withBenchmark.map((x) => x.index));
  const floor = maxIndex * QUALITY_FLOOR_RATIO;
  const prices = withBenchmark.map((x) => x.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice;

  for (const { c, index, price } of withBenchmark) {
    if (index >= floor) {
      const cheapness = priceRange > 0 ? (maxPrice - price) / priceRange : 1;
      const bonus = WEIGHTS.valueBonusMax * cheapness;
      c.score += bonus;
      c.reasons.push(
        `good enough for ${taskType} (external benchmark ${index.toFixed(1)} >= ${floor.toFixed(1)} floor) — value bonus +${bonus.toFixed(1)} for $${(price * 1e6).toFixed(2)}/M tokens`
      );
    } else {
      c.score += WEIGHTS.valueFloorPenalty;
      c.reasons.push(`external benchmark ${index.toFixed(1)} is below the ${floor.toFixed(1)} "good enough" floor for ${taskType} — deprioritized, not excluded`);
    }
  }
}

/**
 * Scores every registry entry for a task, applying the internal
 * deterministic formula and then (when external benchmark data is present
 * on any eligible candidate) the value-scoring stage above. Shared by both
 * rankRegistryByTask (the dashboard panel) and selectRoute (the live
 * per-request decision) so the two can never diverge — what the panel
 * shows is what actually happens.
 */
function scoreAndRankCandidates(registry, taskProfile, taskRoutes) {
  const scored = registry.map((entry) => {
    const eligibility = passesHardEligibility(entry, taskProfile);
    if (!eligibility.ok) {
      return { provider: entry.provider, model: entry.model, excluded: true, reasonCode: eligibility.reasonCode, score: null, reasons: [] };
    }
    const { score, reasons } = scoreCandidate(entry, taskProfile, taskRoutes);
    return { provider: entry.provider, model: entry.model, excluded: false, score, reasons, entry };
  });

  applyValueScoring(
    scored.filter((s) => !s.excluded),
    taskProfile.taskType
  );

  for (const s of scored) {
    delete s.entry;
  }
  return scored;
}

export const TASK_TYPES = Object.keys(TASK_COST_PREFERENCE);

/**
 * Real, inspectable methodology for the "Model Routing" dashboard's task
 * ranking — not an external benchmark. Exposed via /api/routing/registry
 * so the dashboard's "sources" popup shows the actual live formula rather
 * than a static description that could drift from the code.
 */
export function scoringMethodology() {
  return {
    kind: "internal-deterministic-plus-value",
    description:
      "PARAGON's own deterministic routing formula, computed live from real inputs (health checks, circuit-breaker state, configured cost class, " +
      "your routing.taskRoutes preferences) — the exact same formula that picks the live route for real requests, not a separate/different score. " +
      "When an OpenRouter API key is configured and a candidate has a matched external benchmark, a second value-scoring stage runs: it finds the " +
      "best available quality index for the task, treats anything within " +
      `${Math.round(QUALITY_FLOOR_RATIO * 100)}% of it as "good enough", and rewards the cheapest good-enough candidate — not the highest-scoring ` +
      "one. Candidates below that floor are deprioritized, never hard-excluded. Candidates with no benchmark match are scored purely on the " +
      "internal formula, never penalized for lacking external data.",
    weights: WEIGHTS,
    taskCostPreference: TASK_COST_PREFERENCE,
    qualityFloorRatio: QUALITY_FLOOR_RATIO
  };
}

/**
 * Ranks every eligible registry entry against every task type, 1-10 scale
 * (1 = best fit, 10 = worst), derived by ordinal position within that
 * task's eligible candidates — not an absolute quality score, since there
 * is no ground-truth benchmark backing it. Ineligible entries (unhealthy,
 * circuit-open, automatic-eligibility disabled) are listed with their
 * exclusion reason instead of a rank.
 */
export function rankRegistryByTask(registry, taskRoutes, taskTypes = TASK_TYPES) {
  const result = {};
  for (const taskType of taskTypes) {
    const taskProfile = { taskType, estimatedInputTokens: null };
    const scored = scoreAndRankCandidates(registry, taskProfile, taskRoutes);
    const eligible = scored.filter((s) => !s.excluded).sort((a, b) => b.score - a.score);
    const n = eligible.length;
    eligible.forEach((item, index) => {
      item.rank = index + 1;
      item.of = n;
      item.tenScale = n <= 1 ? 1 : Math.max(1, Math.min(10, Math.round(1 + (index / (n - 1)) * 9)));
    });

    result[taskType] = [...eligible, ...scored.filter((s) => s.excluded)];
  }
  return result;
}

/**
 * @param {object} params
 * @param {object} params.config - full PARAGON config
 * @param {object} params.statuses - current /api/status snapshot (avoids re-probing CLIs)
 * @param {object} params.taskProfile - { taskType, estimatedInputTokens }
 * @param {object} [params.hints] - { forceProvider, forceModel, maxCostClass, disableEscalation }
 * @param {object[]} [params.benchmarkRows] - rows from getBenchmarkData(), or [] if not configured
 * @returns {{ provider: string, model: string, reasonCode: string, ranking: object[], confidence: string } | null}
 */
export function selectRoute({ config, statuses, taskProfile, hints = {}, benchmarkRows = [] }) {
  const rawRegistry = buildModelRegistry(config, statuses);
  const registry = benchmarkRows.length ? annotateRegistryWithBenchmarks(rawRegistry, benchmarkRows) : rawRegistry;

  // Force is resolved directly against config, not the registry — a
  // provider that hasn't had "Load models" run yet (empty models[], so
  // zero registry entries) must still be forceable. The registry is only
  // the input to *scoring*; forcing bypasses scoring entirely.
  if (hints.forceProvider) {
    const providerConfig = config.providers?.[hints.forceProvider];
    if (providerConfig?.enabled) {
      const model = hints.forceModel || providerConfig.model || "";
      return {
        provider: hints.forceProvider,
        model,
        reasonCode: "hint.forceProvider",
        ranking: [{ provider: hints.forceProvider, model, score: null, reasons: ["explicitly forced by request hint"] }],
        confidence: "explicit"
      };
    }
  }

  const costCeiling = hints.maxCostClass ? ["economy", "standard", "premium"].indexOf(hints.maxCostClass) : null;
  const costFiltered = registry.filter((entry) => {
    if (costCeiling != null && ["economy", "standard", "premium"].indexOf(entry.costClass) > costCeiling) {
      return false;
    }
    return true;
  });

  const ranking = scoreAndRankCandidates(costFiltered, taskProfile, config.routing?.taskRoutes).sort(
    (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)
  );

  const winner = ranking.find((candidate) => !candidate.excluded);
  if (!winner) {
    return null;
  }

  return {
    provider: winner.provider,
    model: winner.model,
    reasonCode: "scored.deterministic",
    ranking,
    confidence: ranking.filter((c) => !c.excluded).length > 1 ? "scored" : "only-eligible-candidate"
  };
}

/**
 * Turns a selectRoute() ranking into a provider-attempt chain, one entry
 * per distinct eligible provider (highest-scored model for that provider),
 * in ranked order. This is what actually differs from the old static
 * fallbackChain: each attempt carries the model the scorer picked for it,
 * not just whatever was statically configured on the provider.
 */
export function buildRankedAttempts(ranking, config, { limit = 4 } = {}) {
  const seen = new Set();
  const attempts = [];
  for (const candidate of ranking) {
    if (candidate.excluded || seen.has(candidate.provider) || attempts.length >= limit) {
      continue;
    }
    const providerConfig = config.providers[candidate.provider];
    if (!providerConfig?.enabled) {
      continue;
    }
    seen.add(candidate.provider);
    attempts.push({
      name: candidate.provider,
      config: { ...providerConfig, model: candidate.model || providerConfig.model }
    });
  }
  return attempts;
}
