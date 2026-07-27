import { TIER_RANK } from "./constants.js";
import { getRegistryEntry } from "./registry.js";
import {
  isSafeCheapEscalationContext,
  mergeSafeCheapEscalation
} from "./validator.js";

export function nextEscalationTier(currentTier) {
  const rank = TIER_RANK[currentTier] ?? 1;
  const next = Object.entries(TIER_RANK).find(([, value]) => value === rank + 1);
  return next?.[0] ?? null;
}

export function findEscalationCandidate(registry, currentEntry, reason) {
  if (!currentEntry) {
    return null;
  }

  const fallbackIds = currentEntry.routing?.fallbacks ?? [];
  for (const id of fallbackIds) {
    const entry = getRegistryEntry(registry, id);
    if (entry) {
      return { entry, reason: reason ?? "fallback_chain" };
    }
  }

  const nextTier = nextEscalationTier(currentEntry.tier);
  if (!nextTier) {
    return null;
  }

  const upgraded = registry
    .filter((entry) => (TIER_RANK[entry.tier] ?? 0) >= (TIER_RANK[nextTier] ?? 0))
    .filter((entry) => entry.id !== currentEntry.id)
    .sort((a, b) => (TIER_RANK[a.tier] ?? 0) - (TIER_RANK[b.tier] ?? 0));

  if (!upgraded.length) {
    return null;
  }

  return { entry: upgraded[0], reason: reason ?? "tier_escalation" };
}

/**
 * Safe-cheap escalation:
 *   same model retry (caller) → next cheapest floor-passing model → legacy → premium only if justified.
 * Never jumps to premium on plain schema_failure for safe cheap text tasks.
 */
export function findSafeCheapEscalationCandidate({
  registry,
  currentEntry,
  validation,
  decision,
  settings,
  requestMeta = {},
  floorPassingCandidates = [],
  legacyEntry = null,
  attemptedIds = [],
  sameModelRetried = false
}) {
  const policy = mergeSafeCheapEscalation(settings);
  if (!isSafeCheapEscalationContext(decision, policy)) {
    return findEscalationCandidate(registry, currentEntry, validation?.category ?? "validation_failure");
  }

  const explicitStrictJson =
    requestMeta.requiresStrictJson === true ||
    requestMeta.responseFormatJson === true ||
    requestMeta.strict_json === true;

  // Plain chat/text schema_failure is a validator bug — do not escalate.
  if (
    validation?.category === "schema_failure" &&
    !policy.allowPremiumOnSchemaFailure &&
    !explicitStrictJson &&
    (decision?.task_type === "chat" ||
      decision?.task_type === "rewrite" ||
      decision?.task_type === "summarize" ||
      decision?.task_type === "math" ||
      decision?.task_type === "extract")
  ) {
    return {
      entry: null,
      reason: "validator_bug_schema_failure",
      skip: true,
      allowPremium: false
    };
  }

  const attempted = new Set(attemptedIds.filter(Boolean));
  if (currentEntry?.id) {
    attempted.add(currentEntry.id);
  }

  // 1) Same-model retry once for transient / format issues.
  if (
    policy.retrySameModelOnce &&
    !sameModelRetried &&
    isTransientOrFormatIssue(validation)
  ) {
    return {
      entry: currentEntry,
      reason: "retry_same_model",
      retrySame: true,
      allowPremium: false
    };
  }

  // 2) Next cheapest floor-passing model (non-premium, within ceiling).
  if (policy.fallbackToNextFloorPassingModel) {
    const maxRank = TIER_RANK[policy.maxEscalationTier ?? "cheap"] ?? TIER_RANK.cheap;
    const nextFloor = (floorPassingCandidates.length ? floorPassingCandidates : registry)
      .filter((entry) => entry && entry.id !== currentEntry?.id && !attempted.has(entry.id))
      .filter((entry) => (TIER_RANK[entry.tier] ?? 99) <= maxRank)
      .sort(compareByCostThenTier);

    if (nextFloor[0]) {
      return {
        entry: nextFloor[0],
        reason: "next_floor_passing_model",
        allowPremium: false
      };
    }
  }

  // 3) Legacy provider if it is not premium (or premium only after repeated failure).
  if (legacyEntry && !attempted.has(legacyEntry.id)) {
    const legacyRank = TIER_RANK[legacyEntry.tier] ?? 99;
    const maxRank = TIER_RANK[policy.maxEscalationTier ?? "cheap"] ?? TIER_RANK.cheap;
    if (legacyRank <= maxRank) {
      return {
        entry: legacyEntry,
        reason: "legacy_provider",
        allowPremium: false
      };
    }
  }

  // 4) Premium only when justified.
  const allowPremium =
    !policy.premiumOnlyAfterRepeatedFailure ||
    attempted.size >= 2 ||
    explicitStrictJson ||
    (decision?.recommended_tier === "premium") ||
    (decision?.complexity ?? 0) >= 4 ||
    (decision?.risk ?? 0) >= 4;

  if (!allowPremium) {
    return {
      entry: null,
      reason: "premium_blocked_safe_cheap",
      skip: true,
      allowPremium: false
    };
  }

  const premium = findEscalationCandidate(
    registry,
    currentEntry,
    validation?.category ?? "validation_failure"
  );
  if (premium?.entry && (TIER_RANK[premium.entry.tier] ?? 0) >= TIER_RANK.premium) {
    return { ...premium, allowPremium: true };
  }
  return premium
    ? { ...premium, allowPremium: true }
    : { entry: null, reason: "no_escalation_candidate", skip: true, allowPremium: false };
}

export function buildEscalationChain(registry, startEntry, maxSteps = 3) {
  const chain = [startEntry];
  let current = startEntry;

  for (let step = 0; step < maxSteps; step += 1) {
    const next = findEscalationCandidate(registry, current, "chain");
    if (!next || chain.some((entry) => entry.id === next.entry.id)) {
      break;
    }
    chain.push(next.entry);
    current = next.entry;
  }

  return chain;
}

function isTransientOrFormatIssue(validation) {
  const category = validation?.category;
  return (
    category === "empty_output" ||
    category === "provider_error" ||
    category === "severe_malformed" ||
    category === "schema_failure" ||
    validation?.issues?.includes("empty_response")
  );
}

function compareByCostThenTier(a, b) {
  const costA = effectiveCost(a);
  const costB = effectiveCost(b);
  if (costA !== costB) {
    return costA - costB;
  }
  return (TIER_RANK[a.tier] ?? 0) - (TIER_RANK[b.tier] ?? 0);
}

function effectiveCost(entry) {
  if (typeof entry?.effective_cost === "number") {
    return entry.effective_cost;
  }
  const pricing = entry?.pricing ?? {};
  const input = Number(pricing.input_per_1m ?? pricing.input ?? 0);
  const output = Number(pricing.output_per_1m ?? pricing.output ?? 0);
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return (Number.isFinite(input) ? input : 0) * 0.3 + (Number.isFinite(output) ? output : 0) * 0.7;
  }
  return TIER_RANK[entry?.tier] ?? 99;
}
