/**
 * Same-provider alternate-model fallback (PARAGON-D-004D, Phase 9).
 *
 * The D-004C1 chain kept exactly one model per provider — the highest-ranked
 * one — and discarded every other eligible model from that provider. So a
 * model-specific rejection (MODEL_NOT_FOUND on one id) forced an immediate
 * provider switch even when the same provider had a perfectly good
 * second-best model already validated.
 *
 * The plan is now provider-model-profile granular, and failure handling is
 * classified: a model-specific failure advances within the provider, a
 * provider-wide failure abandons the provider entirely.
 */

import { isProviderDefaultId } from "../modelCapability.js";

/** Failures that condemn the exact model/profile only. */
export const MODEL_SPECIFIC_FAILURES = new Set(["MODEL_NOT_FOUND", "MODEL_REJECTED", "MODEL_UNAVAILABLE"]);

/** Failures that condemn every remaining attempt for that provider. */
export const PROVIDER_WIDE_FAILURES = new Set(["AUTHENTICATION_FAILED", "QUOTA_EXHAUSTED", "ENTITLEMENT_REQUIRED", "PROVIDER_OFFLINE", "CONFIGURATION_ERROR"]);

/** Failures that are worth a bounded retry before moving on. */
export const RETRYABLE_FAILURES = new Set(["RATE_LIMITED", "TIMEOUT", "TRANSIENT_FAILURE"]);

/**
 * Builds an ordered attempt plan from a ranking.
 *
 * @param {object[]} ranked - output of rankCandidates().ranked
 * @param {object} config - PARAGON config (for provider enablement)
 * @param {object} [options]
 * @param {number} [options.maximumAttempts] - total attempt cap (preserves the D-004C1 fallback limit)
 * @param {number} [options.maxPerProvider] - alternates allowed per provider
 */
export function buildAttemptPlan(ranked, config, { maximumAttempts = 4, maxPerProvider = 2 } = {}) {
  const perProvider = new Map();
  const plan = [];

  for (const candidate of ranked) {
    if (candidate.excluded || !candidate.providerModelId) {
      continue;
    }
    if (plan.length >= maximumAttempts) {
      break;
    }
    const providerConfig = config?.providers?.[candidate.provider];
    if (!providerConfig?.enabled) {
      continue;
    }
    const used = perProvider.get(candidate.provider) ?? 0;
    if (used >= maxPerProvider) {
      continue;
    }
    perProvider.set(candidate.provider, used + 1);

    const providerDefault = isProviderDefaultId(candidate.providerModelId);
    plan.push({
      name: candidate.provider,
      providerDefault,
      // The registry row this attempt is traceable to (D-004C1 P0-8).
      registryModel: candidate.providerModelId,
      canonicalModelId: candidate.canonicalModelId,
      executionProfile: candidate.executionProfile ?? "default",
      reasoningEffort: candidate.reasoningEffort,
      speedMode: candidate.speedMode,
      // Ranked candidates expose the normalized effort as `reasoningEffort`;
      // the original candidate carries the richer execution-profile object.
      // Preserve either representation so a ranked tuple cannot silently
      // dispatch with an `unknown` reasoning profile.
      reasoningProfile: candidate.reasoningProfile
        ?? candidate.reasoningEffort
        ?? candidate.executionProfile?.reasoningEffort
        ?? "unknown",
      executionMethod: candidate.executionMethod ?? (candidate.isHttpProvider ? "openai_compatible_http" : "native_agent_cli"),
      executionPath: candidate.executionPath ?? (candidate.isHttpProvider ? "openai-compatible-http" : "native-agent-cli"),
      expertId: candidate.expertId ?? `${candidate.provider}|${candidate.canonicalModelId ?? candidate.providerModelId}`,
      expectedUtility: candidate.expectedUtility,
      alternateIndexForProvider: used,
      config: {
        ...providerConfig,
        model: providerDefault ? "" : candidate.providerModelId,
        reasoningProfile: candidate.reasoningProfile
          ?? candidate.reasoningEffort
          ?? providerConfig.reasoningProfile
          ?? "unknown"
      }
    });
  }

  return plan;
}

/**
 * Decides what to do after one attempt fails.
 *
 * @returns {{action: "next_same_provider"|"skip_provider"|"retry"|"next_provider", reason: string}}
 */
export function planNextAfterFailure({ classification, attempt, remainingPlan, retriesUsed = 0, maxRetriesPerAttempt = 1 }) {
  if (MODEL_SPECIFIC_FAILURES.has(classification)) {
    const sameProvider = remainingPlan.some((a) => a.name === attempt.name);
    return sameProvider
      ? { action: "next_same_provider", reason: `${classification} condemns only ${attempt.name}/${attempt.registryModel}; another eligible model from the same provider remains` }
      : { action: "next_provider", reason: `${classification} condemns ${attempt.name}/${attempt.registryModel} and no alternate model from that provider is eligible` };
  }

  if (PROVIDER_WIDE_FAILURES.has(classification)) {
    return { action: "skip_provider", reason: `${classification} is provider-wide; skipping all remaining ${attempt.name} attempts` };
  }

  if (RETRYABLE_FAILURES.has(classification)) {
    if (retriesUsed < maxRetriesPerAttempt) {
      return { action: "retry", reason: `${classification} is transient; bounded retry ${retriesUsed + 1}/${maxRetriesPerAttempt}` };
    }
    return { action: "next_provider", reason: `${classification} persisted past the retry budget` };
  }

  return { action: "next_provider", reason: `unclassified failure (${classification ?? "unknown"}); advancing conservatively` };
}

/**
 * Filters a plan after a failure, honoring the classification. Never retries
 * the same rejected provider-model-profile inside one request.
 */
export function applyFailureToPlan(plan, { attempt, classification }) {
  const key = (a) => `${a.name}/${a.registryModel}/${a.executionProfile}`;
  const failedKey = key(attempt);

  if (PROVIDER_WIDE_FAILURES.has(classification)) {
    return plan.filter((a) => a.name !== attempt.name);
  }
  return plan.filter((a) => key(a) !== failedKey);
}

/** Human-readable plan summary for shadow records and the dashboard. */
export function summarizeAttemptPlan(plan) {
  return plan.map((a, index) => ({
    order: index + 1,
    provider: a.name,
    providerModelId: a.registryModel,
    canonicalModelId: a.canonicalModelId,
    reasoningEffort: a.reasoningEffort,
    reasoningProfile: a.reasoningProfile,
    executionMethod: a.executionMethod,
    executionPath: a.executionPath,
    expertId: a.expertId,
    speedMode: a.speedMode,
    providerDefault: a.providerDefault,
    alternateForProvider: a.alternateIndexForProvider > 0,
    expectedUtility: a.expectedUtility
  }));
}
