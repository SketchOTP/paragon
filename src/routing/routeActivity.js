/**
 * Last-observed routing activity (PARAGON-D-004D1).
 *
 * The dashboard used to imply that `providers[x].model` was the model a
 * provider "will use". It isn't — the model is chosen per request from the
 * ranked eligible registry. To replace that claim with something true, the
 * dashboard needs the *observed* answer: which model each provider actually
 * ran last, and which model the D-004D shadow scorer would have picked.
 *
 * This store holds exactly that and nothing else:
 *
 *  - No prompts, no responses, no credentials, no headers.
 *  - Bounded by construction: one record per provider plus one latest
 *    attempt plan per engine. Traffic cannot grow it.
 *  - In-memory only. It is an observation of the current process, so a
 *    restart correctly reports "not observed yet" rather than replaying a
 *    stale claim from disk.
 *
 * Recording is advisory instrumentation: it never participates in a routing
 * decision, and every call site treats a failure here as ignorable.
 */

/** Attempt plans are already short (maximumAttempts defaults to 4); cap defensively. */
const MAX_PLAN_ENTRIES = 12;

function normalizePlan(plan) {
  if (!Array.isArray(plan)) {
    return [];
  }
  return plan.slice(0, MAX_PLAN_ENTRIES).map((entry, index) => ({
    order: entry.order ?? index + 1,
    provider: entry.provider ?? null,
    model: entry.model ?? entry.providerModelId ?? null,
    providerDefault: Boolean(entry.providerDefault),
    alternateForProvider: Boolean(entry.alternateForProvider)
  }));
}

export function createRouteActivityStore() {
  /** provider -> { model, at, providerDefault } */
  const lastLiveByProvider = new Map();
  /** provider -> { model, at, reasoningEffort, speedMode } */
  const lastShadowByProvider = new Map();
  let latestLivePlan = null;
  let latestShadowPlan = null;

  return {
    /**
     * Records the live D-004C1 *decision* — the ranked attempt plan the scorer
     * produced for this request. Deliberately separate from recordExecuted():
     * a request can be planned and then blocked by a live-enforcement gate
     * (context ceiling, concurrency, session limit) without any provider
     * running, so a plan is not evidence that a model was used.
     */
    recordLivePlan({ taskType = null, attemptPlan = [], at = new Date().toISOString() } = {}) {
      const plan = normalizePlan(attemptPlan);
      if (plan.length) {
        latestLivePlan = { engine: "paragon-d-004c1", at, taskType, plan };
      }
    },

    /**
     * Records the provider-model pair that actually produced the response.
     * This is what the provider card reports as its last live model, so it
     * must be the executor — which fallback and JSON-validation escalation can
     * legitimately make different from the head of the plan above.
     */
    recordExecuted({ provider, model, providerDefault = false, at = new Date().toISOString() } = {}) {
      if (!provider) {
        return;
      }
      lastLiveByProvider.set(provider, { model: model ?? null, providerDefault: Boolean(providerDefault), at });
    },

    /**
     * Records the D-004D shadow winner for a request. Shadow never executes,
     * so this is explicitly a recommendation, not a usage record.
     */
    recordShadow({ provider, model, reasoningEffort = null, speedMode = null, taskProfile = null, attemptPlan = [], agrees = null, confidence = null, at = new Date().toISOString() } = {}) {
      if (provider) {
        lastShadowByProvider.set(provider, { model: model ?? null, reasoningEffort, speedMode, at });
      }
      const plan = normalizePlan(attemptPlan);
      if (plan.length) {
        latestShadowPlan = {
          engine: "paragon-d-004d",
          at,
          // Only the derived profile shape — never the prompt it came from.
          taskProfile: taskProfile
            ? {
                workType: taskProfile.workType ?? null,
                complexity: taskProfile.complexity ?? null,
                reasoningDemand: taskProfile.reasoningDemand ?? null,
                contextBand: taskProfile.contextBand ?? null,
                outputContract: taskProfile.outputContract ?? null,
                latencyPreference: taskProfile.latencyPreference ?? null,
                costSensitivity: taskProfile.costSensitivity ?? null
              }
            : null,
          agrees,
          confidence,
          plan
        };
      }
    },

    lastLive(provider) {
      return lastLiveByProvider.get(provider) ?? null;
    },

    lastShadow(provider) {
      return lastShadowByProvider.get(provider) ?? null;
    },

    /** Latest recorded attempt plan per engine, for the dashboard's side-by-side view. */
    plans() {
      return { live: latestLivePlan, shadow: latestShadowPlan };
    },

    reset() {
      lastLiveByProvider.clear();
      lastShadowByProvider.clear();
      latestLivePlan = null;
      latestShadowPlan = null;
    }
  };
}
