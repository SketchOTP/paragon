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
import { isCircuitOpen, circuitStateSnapshot } from "../orchestration/liveEnforcement.js";

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
  circuitHalfOpen: -1
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

export const TASK_TYPES = Object.keys(TASK_COST_PREFERENCE);

/**
 * Real, inspectable methodology for the "Model Routing" dashboard's task
 * ranking — not an external benchmark. Exposed via /api/routing/registry
 * so the dashboard's "sources" popup shows the actual live formula rather
 * than a static description that could drift from the code.
 */
export function scoringMethodology() {
  return {
    kind: "internal-deterministic",
    description:
      "PARAGON has no live internet access and runs no evaluation harness against these models, so this is not an external benchmark citation. " +
      "It is PARAGON's own deterministic routing formula, computed live from real inputs (health checks, circuit-breaker state, configured cost class, " +
      "your routing.taskRoutes preferences) — the exact same formula that picks the live route for real requests, not a separate/different score.",
    weights: WEIGHTS,
    taskCostPreference: TASK_COST_PREFERENCE
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
    const scored = registry.map((entry) => {
      const eligibility = passesHardEligibility(entry, taskProfile);
      if (!eligibility.ok) {
        return { provider: entry.provider, model: entry.model, excluded: true, reasonCode: eligibility.reasonCode, score: null, reasons: [] };
      }
      const { score, reasons } = scoreCandidate(entry, taskProfile, taskRoutes);
      return { provider: entry.provider, model: entry.model, excluded: false, score, reasons };
    });

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
 * @returns {{ provider: string, model: string, reasonCode: string, ranking: object[], confidence: string } | null}
 */
export function selectRoute({ config, statuses, taskProfile, hints = {} }) {
  const registry = buildModelRegistry(config, statuses);

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

  const ranking = registry
    .filter((entry) => {
      if (costCeiling != null && ["economy", "standard", "premium"].indexOf(entry.costClass) > costCeiling) {
        return false;
      }
      return true;
    })
    .map((entry) => {
      const eligibility = passesHardEligibility(entry, taskProfile);
      if (!eligibility.ok) {
        return { provider: entry.provider, model: entry.model, score: null, excluded: true, reasonCode: eligibility.reasonCode };
      }
      const { score, reasons } = scoreCandidate(entry, taskProfile, config.routing?.taskRoutes);
      return { provider: entry.provider, model: entry.model, score, reasons, excluded: false };
    })
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

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
