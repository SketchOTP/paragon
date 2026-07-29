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
import { isProviderDefaultId } from "../modelCapability.js";
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
  if (entry.pendingAssessment) {
    return { ok: false, reasonCode: "routing.providerPendingAssessment" };
  }
  if (!entry.model) {
    return { ok: false, reasonCode: "eligibility.noModelResolved" };
  }
  if (!entry.automaticEligibility) {
    return { ok: false, reasonCode: "eligibility.automaticEligibilityDisabled" };
  }
  // P0-5: defense in depth. buildModelRegistry already drops models
  // positively identified as non-chat, so reaching this means an entry
  // arrived from a path that skipped that filter.
  if (entry.capabilities && entry.capabilities.chatCompletions === false) {
    return { ok: false, reasonCode: "routing.chatCapabilityUnsupported" };
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
 * @param {object} [params.catalog] - PARAGON-D-004C model-catalog store (src/modelCatalog.js); gates automaticEligibility when supplied
 * @returns {{ provider: string, model: string, reasonCode: string, ranking: object[], confidence: string } | null}
 */
export function selectRoute({ config, statuses, taskProfile, hints = {}, benchmarkRows = [], catalog = null }) {
  const rawRegistry = buildModelRegistry(config, statuses, catalog);
  const registry = benchmarkRows.length ? annotateRegistryWithBenchmarks(rawRegistry, benchmarkRows) : rawRegistry;

  const costOrder = ["economy", "standard", "premium"];
  const costCeiling = hints.maxCostClass ? costOrder.indexOf(hints.maxCostClass) : null;
  const overCostCeiling = (entry) =>
    costCeiling != null && costOrder.indexOf(entry.costClass) > costCeiling;
  const costFiltered = registry.filter((entry) => !overCostCeiling(entry));

  // PARAGON-D-004C1 (P0-2): a forced route is resolved against the *eligible
  // registry*, never against config. Previously this returned before cost
  // filtering, health/circuit/context checks, and catalog validation, so any
  // `/v1` client could name a rejected or nonexistent model via
  // X-Paragon-Force-Model and have it dispatched — and an absent model fell
  // through to providerConfig.model. Forcing now only ever *narrows* the
  // candidate set; it can never widen it past a gate. An unrestricted
  // operator override is deliberately out of scope for this hotfix and is
  // not exposed on the public API.
  if (hints.forceProvider) {
    const providerConfig = config.providers?.[hints.forceProvider];
    if (!providerConfig?.enabled) {
      return rejection("routing.forcedProviderNotEligible", `Provider "${hints.forceProvider}" is not enabled.`);
    }

    const providerEntries = registry.filter((entry) => entry.provider === hints.forceProvider && entry.model);
    if (!providerEntries.length) {
      const pending = registry.some((entry) => entry.provider === hints.forceProvider && entry.pendingAssessment);
      if (pending) {
        return rejection(
          "routing.providerPendingAssessment",
          `Provider "${hints.forceProvider}" has not completed model-catalog assessment yet.`
        );
      }
      // When the caller named a specific model, report at model granularity —
      // "your model isn't eligible" is more actionable than "this provider
      // has nothing", even though both are true here.
      return hints.forceModel
        ? rejection(
            "routing.forcedModelNotEligible",
            `Model "${hints.forceModel}" is not currently exposed or validated for provider "${hints.forceProvider}".`
          )
        : rejection("routing.forcedProviderNotEligible", `Provider "${hints.forceProvider}" has no catalog-eligible models.`);
    }

    let targeted = providerEntries;
    if (hints.forceModel) {
      targeted = providerEntries.filter((entry) => entry.model === hints.forceModel);
      if (!targeted.length) {
        return rejection(
          "routing.forcedModelNotEligible",
          `Model "${hints.forceModel}" is not currently exposed or validated for provider "${hints.forceProvider}".`
        );
      }
      if (overCostCeiling(targeted[0])) {
        return rejection(
          "routing.forcedModelNotEligible",
          `Model "${hints.forceModel}" exceeds the requested max cost class "${hints.maxCostClass}".`
        );
      }
    } else {
      targeted = targeted.filter((entry) => !overCostCeiling(entry));
      if (!targeted.length) {
        return rejection(
          "routing.forcedProviderNotEligible",
          `Provider "${hints.forceProvider}" has no eligible model within max cost class "${hints.maxCostClass}".`
        );
      }
    }

    // Still subject to every request-specific hard gate (health, circuit,
    // context fit, capability) — scored so the best remaining model for the
    // forced provider wins rather than an arbitrary one.
    const forcedRanking = scoreAndRankCandidates(targeted, taskProfile, config.routing?.taskRoutes).sort(
      (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)
    );
    const forcedWinner = forcedRanking.find((candidate) => !candidate.excluded);
    if (!forcedWinner) {
      const why = forcedRanking[0]?.reasonCode ?? "eligibility.unknown";
      return rejection(
        hints.forceModel ? "routing.forcedModelNotEligible" : "routing.forcedProviderNotEligible",
        `Forced route for "${hints.forceProvider}" failed an eligibility gate (${why}).`
      );
    }

    return {
      provider: forcedWinner.provider,
      model: forcedWinner.model,
      reasonCode: "hint.forceProvider",
      ranking: forcedRanking,
      confidence: "explicit"
    };
  }

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

/** A forced route that failed a gate — surfaced as a bounded 400, never silently downgraded to automatic routing. */
function rejection(reasonCode, message) {
  return { rejected: true, reasonCode, message, ranking: [] };
}

/**
 * Turns a selectRoute() ranking into a provider-attempt chain, one entry
 * per distinct eligible provider (highest-scored model for that provider),
 * in ranked order. Each attempt carries the model the scorer picked for it,
 * not whatever was statically configured on the provider.
 *
 * PARAGON-D-004C1 (P0-8): every attempt must be traceable to a ranked
 * eligible registry row. A candidate with no resolved model is skipped
 * outright — the previous `candidate.model || providerConfig.model`
 * substitution could quietly reintroduce a stale configured model that the
 * catalog had already removed. A provider-default route is instead carried
 * explicitly by a validated PROVIDER_DEFAULT_MODEL_ID registry entry, which
 * is translated to an empty `model` (so the provider picks) only here, at
 * the point of execution.
 */
export function buildRankedAttempts(ranking, config, { limit = 4 } = {}) {
  const seen = new Set();
  const attempts = [];
  for (const candidate of ranking) {
    if (candidate.excluded || seen.has(candidate.provider) || attempts.length >= limit) {
      continue;
    }
    if (!candidate.model) {
      continue;
    }
    const providerConfig = config.providers[candidate.provider];
    if (!providerConfig?.enabled) {
      continue;
    }
    const providerDefault = isProviderDefaultId(candidate.model);
    seen.add(candidate.provider);
    attempts.push({
      name: candidate.provider,
      providerDefault,
      registryModel: candidate.model,
      config: { ...providerConfig, model: providerDefault ? "" : candidate.model }
    });
  }
  return attempts;
}

/**
 * P0-8 assertion, evaluated immediately before dispatch: re-derives each
 * attempt against the current registry so a chain can never carry a row
 * that isn't presently eligible. Returns the offending attempts rather
 * than throwing, so the caller can fail the request with a bounded error.
 */
export function verifyAttemptsAgainstRegistry(attempts, registry, config) {
  const eligible = new Map();
  for (const entry of registry) {
    if (entry.model && entry.automaticEligibility && !entry.pendingAssessment) {
      eligible.set(`${entry.provider}/${entry.model}`, entry);
    }
  }
  const violations = [];
  for (const attempt of attempts) {
    const providerConfig = config.providers?.[attempt.name];
    if (!providerConfig?.enabled) {
      violations.push({ attempt: attempt.name, reason: "provider not enabled" });
      continue;
    }
    const key = `${attempt.name}/${attempt.registryModel ?? attempt.config?.model}`;
    const entry = eligible.get(key);
    if (!entry) {
      violations.push({ attempt: attempt.name, model: attempt.registryModel ?? attempt.config?.model, reason: "not a currently eligible registry entry" });
      continue;
    }
    if (entry.capabilities && entry.capabilities.chatCompletions === false) {
      violations.push({ attempt: attempt.name, model: entry.model, reason: "does not support chat completions" });
    }
  }
  return violations;
}
