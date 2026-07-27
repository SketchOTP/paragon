import { TIER_RANK } from "./constants.js";

export const DEFAULT_EXECUTION = {
  providerTimeoutMs: 90_000,
  retrySameProviderOnTimeout: false,
  fallbackOnProviderTimeout: true,
  maxProviderAttempts: 3
};

export function mergeExecutionConfig(smartRoute = {}) {
  return {
    ...DEFAULT_EXECUTION,
    ...(smartRoute.execution ?? {})
  };
}

/**
 * Build provider attempts for model-intelligence selections.
 * Order: ranked winner → next floor-passing (cheap-first for safe tasks) → legacy → premium last resort.
 */
export function buildIntelligenceAttempts({
  config,
  registry,
  primary,
  legacyProvider,
  smartDecision,
  execution = null,
  isSafeCheap = false,
  maxTier = "cheap"
}) {
  const exec = execution ?? mergeExecutionConfig(config?.routing?.smartRoute ?? {});
  const timeoutMs = exec.providerTimeoutMs ?? DEFAULT_EXECUTION.providerTimeoutMs;
  const maxAttempts = Math.max(1, exec.maxProviderAttempts ?? 3);
  const allowFallback = exec.fallbackOnProviderTimeout !== false;

  const attempts = [];
  const seenIds = new Set();
  const seenProviders = new Set();

  const addEntry = (entry, reason = "ranked") => {
    if (!entry?.provider || attempts.length >= maxAttempts) {
      return false;
    }
    const id = entry.id ?? entry.canonical_id ?? `${entry.provider}:${entry.model ?? "default"}`;
    if (seenIds.has(id)) {
      return false;
    }
    const providerConfig = config.providers[entry.provider];
    if (!providerConfig?.enabled) {
      return false;
    }
    // Prefer distinct providers for timeout recovery (same provider often shares the hang).
    if (seenProviders.has(entry.provider) && attempts.length > 0) {
      return false;
    }
    seenIds.add(id);
    seenProviders.add(entry.provider);
    attempts.push({
      name: entry.provider,
      config: {
        ...providerConfig,
        model: entry.model || providerConfig.model,
        timeoutMs
      },
      canonical_id: id,
      fallback_reason: reason
    });
    return true;
  };

  const winnerId = smartDecision?.selected_canonical_id ?? smartDecision?.ranking_winner_canonical_id;
  const winner =
    registry.find((row) => row.id === winnerId) ??
    smartDecision?.selected ??
    registry.find((row) => row.provider === primary);

  addEntry(winner, "ranking_winner");

  if (!allowFallback) {
    return {
      attempts,
      fallback_candidate_count: 0,
      fallback_block_reason: attempts.length ? "fallback_disabled" : "no_winner"
    };
  }

  const rankedIds = smartDecision?.ranked_fallback_ids ?? smartDecision?.intelligence_ranked_ids ?? [];
  const rankedEntries = rankedIds
    .map((id) => registry.find((row) => row.id === id))
    .filter(Boolean);

  const candidateIds = smartDecision?.candidates ?? [];
  const candidateEntries = candidateIds
    .map((id) => (typeof id === "string" ? registry.find((row) => row.id === id) : id))
    .filter(Boolean);

  const pool = uniqueEntries([
    ...rankedEntries,
    ...candidateEntries,
    ...registry.filter((row) => config.providers[row.provider]?.enabled)
  ]);

  const maxTierRank = isSafeCheap
    ? (TIER_RANK[maxTier] ?? TIER_RANK.cheap)
    : TIER_RANK.premium;

  const floorPassers = pool
    .filter((entry) => entry.id !== winner?.id)
    .filter((entry) => (TIER_RANK[entry.tier] ?? 99) <= maxTierRank)
    .sort(compareByCostThenTier);

  for (const entry of floorPassers) {
    if (attempts.length >= maxAttempts) break;
    addEntry(entry, "next_floor_passing_model");
  }

  // Legacy provider before premium.
  if (attempts.length < maxAttempts && legacyProvider) {
    const legacyEntry =
      registry.find((row) => row.provider === legacyProvider) ??
      ({
        id: `${legacyProvider}:legacy`,
        provider: legacyProvider,
        model: config.providers[legacyProvider]?.model ?? "",
        tier: "mid"
      });
    if ((TIER_RANK[legacyEntry.tier] ?? 99) <= maxTierRank || !isSafeCheap) {
      addEntry(legacyEntry, "legacy_provider");
    }
  }

  // Premium only when we still lack a fallback (safe cheap) or general tasks need more attempts.
  if (attempts.length < 2 || (!isSafeCheap && attempts.length < maxAttempts)) {
    const premium = pool
      .filter((entry) => (TIER_RANK[entry.tier] ?? 0) >= TIER_RANK.premium)
      .sort(compareByCostThenTier);
    for (const entry of premium) {
      if (attempts.length >= maxAttempts) break;
      if (isSafeCheap && attempts.length >= 2) break;
      addEntry(entry, "premium_last_resort");
    }
  }

  const fallbackCandidateCount = Math.max(0, attempts.length - 1);
  return {
    attempts,
    fallback_candidate_count: fallbackCandidateCount,
    fallback_block_reason: fallbackCandidateCount === 0 ? "no_fallback_candidates" : null
  };
}

export function buildTimeoutAudit({
  attempts,
  failedAttempt,
  timeoutMs,
  providerFallbackUsed,
  fallbackCandidateCount,
  fallbackBlockReason
}) {
  const attempted = failedAttempt ?? attempts?.[0] ?? null;
  const candidateCount = fallbackCandidateCount ?? Math.max(0, (attempts?.length ?? 1) - 1);
  const fallbackAttempted = Boolean(providerFallbackUsed);

  let blockReason = null;
  if (!fallbackAttempted) {
    blockReason =
      fallbackBlockReason ??
      (candidateCount === 0 ? "no_fallback_candidates" : "fallback_not_attempted");
  }

  return {
    timeout_ms: timeoutMs ?? attempted?.config?.timeoutMs ?? null,
    attempted_canonical_id: attempted?.canonical_id ?? null,
    attempted_provider: attempted?.name ?? null,
    attempted_model: attempted?.config?.model ?? null,
    fallback_candidate_count: candidateCount,
    fallback_attempted: fallbackAttempted,
    fallback_block_reason: blockReason
  };
}

function uniqueEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function compareByCostThenTier(a, b) {
  const costA = entryCost(a);
  const costB = entryCost(b);
  if (costA !== costB) return costA - costB;
  return (TIER_RANK[a.tier] ?? 0) - (TIER_RANK[b.tier] ?? 0);
}

function entryCost(entry) {
  if (typeof entry?.effective_cost === "number") return entry.effective_cost;
  const pricing = entry?.pricing ?? {};
  const input = Number(pricing.input_per_1m ?? 0);
  const output = Number(pricing.output_per_1m ?? 0);
  if (input || output) return input * 0.3 + output * 0.7;
  return TIER_RANK[entry?.tier] ?? 99;
}
