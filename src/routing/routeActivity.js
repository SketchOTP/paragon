/**
 * Observed routing activity (PARAGON-D-004E).
 *
 * Two jobs:
 *
 *  1. Feed the product's "Recent Activity" list — understandable request
 *     events, not the raw process log. Raw stdout/stderr and reason codes
 *     belong in Diagnostics; this is what an ordinary user reads.
 *
 *  2. Keep the five routing lifecycle states **distinct**, which the live
 *     scorer depends on being true:
 *
 *       planned    - the attempt plan the router produced
 *       attempted  - a provider-model PARAGON actually dispatched
 *       executed   - the provider-model that returned the response
 *       failed     - a provider-model that did not return a response
 *       recovered  - the executor, when it was not the head of the plan
 *
 *     A route that fails before returning a response must never receive
 *     successful-execution credit. Collapsing "planned" into "executed" is
 *     precisely how a plan that was blocked by a gate, or an attempt that
 *     failed over, would have been miscredited as a success.
 *
 * Constraints: no prompts, no responses, no credentials, no headers. Bounded
 * by construction — a fixed-size ring buffer plus one record per provider, so
 * traffic cannot grow it. In-memory only, so a restart honestly reports
 * "not observed yet" rather than replaying a stale claim from disk.
 */

/** Attempt plans are already short (maximumAttempts defaults to 4); cap defensively. */
const MAX_PLAN_ENTRIES = 12;

/** Recent-activity ring buffer size. Bounded so traffic cannot grow this store. */
const DEFAULT_ACTIVITY_LIMIT = 50;

function normalizePlan(plan) {
  if (!Array.isArray(plan)) {
    return [];
  }
  return plan.slice(0, MAX_PLAN_ENTRIES).map((entry, index) => ({
    order: entry.order ?? index + 1,
    provider: entry.provider ?? entry.name ?? null,
    model: entry.model ?? entry.providerModelId ?? entry.registryModel ?? null,
    providerDefault: Boolean(entry.providerDefault),
    alternateForProvider: Boolean(entry.alternateForProvider)
  }));
}

export function createRouteActivityStore({ activityLimit = DEFAULT_ACTIVITY_LIMIT } = {}) {
  /** provider -> { model, at, providerDefault } — last provider-model that actually returned a response. */
  const lastExecutedByProvider = new Map();
  /** provider -> { model, at, reason } — last provider-model that failed. */
  const lastFailureByProvider = new Map();
  let latestPlan = null;
  /** Newest-first ring buffer of completed request events. */
  const activity = [];

  function push(event) {
    activity.unshift(event);
    if (activity.length > activityLimit) {
      activity.length = activityLimit;
    }
  }

  return {
    /**
     * Records the plan the router produced. Deliberately separate from
     * recordExecuted(): a request can be planned and then blocked by a gate
     * without any provider running, so a plan is never evidence of use.
     */
    recordPlanned({ taskType = null, attemptPlan = [], priority = null, at = new Date().toISOString() } = {}) {
      const plan = normalizePlan(attemptPlan);
      if (plan.length) {
        latestPlan = { at, taskType, priority, plan };
      }
    },

    /** Records the provider-model that actually produced the response. */
    recordExecuted({ provider, model, providerDefault = false, at = new Date().toISOString() } = {}) {
      if (!provider) {
        return;
      }
      lastExecutedByProvider.set(provider, { model: model ?? null, providerDefault: Boolean(providerDefault), at });
    },

    /**
     * Records a provider-model that failed. Kept separate from executed so a
     * failed attempt can never be reported as the provider's last used model.
     */
    recordFailed({ provider, model, reason = null, at = new Date().toISOString() } = {}) {
      if (!provider) {
        return;
      }
      lastFailureByProvider.set(provider, { model: model ?? null, reason, at });
    },

    /**
     * One completed request, as the product describes it.
     *
     * @param {object} event
     * @param {boolean} event.success
     * @param {string} [event.provider] - the executor (not the plan head)
     * @param {string} [event.model]
     * @param {number} [event.durationMs]
     * @param {boolean} [event.fallback] - execution moved past the first attempt
     * @param {string} [event.recoveredFrom] - the provider whose failure caused the move
     * @param {string} [event.failureReason] - plain-language reason, already bounded
     */
    recordRequest({
      success,
      provider = null,
      model = null,
      durationMs = null,
      fallback = false,
      recoveredFrom = null,
      recoveredFromReason = null,
      failureReason = null,
      at = new Date().toISOString()
    } = {}) {
      push({
        at,
        success: Boolean(success),
        provider,
        model,
        durationMs,
        fallback: Boolean(fallback),
        recoveredFrom,
        recoveredFromReason,
        failureReason
      });
    },

    /** Newest-first recent request events for the product's Activity list. */
    recent({ limit = activityLimit } = {}) {
      return activity.slice(0, Math.max(0, Math.min(activityLimit, limit)));
    },

    lastExecuted(provider) {
      return lastExecutedByProvider.get(provider) ?? null;
    },

    lastFailure(provider) {
      return lastFailureByProvider.get(provider) ?? null;
    },

    /** The most recent attempt plan, for Diagnostics. */
    plan() {
      return latestPlan;
    },

    /** The most recent successful route, for the Automatic Routing card. */
    latestSuccess() {
      return activity.find((event) => event.success) ?? null;
    },

    /** The most recent fallback recovery, for the Automatic Routing card. */
    latestRecovery() {
      return activity.find((event) => event.success && event.fallback) ?? null;
    },

    reset() {
      lastExecutedByProvider.clear();
      lastFailureByProvider.clear();
      latestPlan = null;
      activity.length = 0;
    }
  };
}
