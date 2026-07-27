/**
 * Health inheritance groups: probe one execution target per adapter group,
 * inherit health to catalog variants that share the same adapter path.
 */

export const CLI_GROUP_PROVIDERS = new Set([
  "cursor",
  "codex",
  "claude",
  "antigravity"
]);

export const LOCAL_GROUP_PROVIDERS = new Set(["lmstudio"]);

/** Tasks that require direct (or high-confidence) health, not inherited alone. */
export const HIGH_RISK_TASKS = new Set([
  "code",
  "code_debug",
  "architecture",
  "high_stakes"
]);

export const HEALTH_CONFIDENCE = {
  direct_probe: 1.0,
  inherited_group: 0.75,
  prior_snapshot_fresh: 0.7,
  prior_snapshot_stale: 0.4,
  unknown: 0
};

const PRIOR_FRESH_HOURS = 36;

/**
 * Attach health group metadata to a discovered model row.
 */
export function attachHealthGroup(row, config = {}) {
  const meta = resolveHealthGroup(row, config);
  return {
    ...row,
    adapter: meta.adapter,
    health_group_id: meta.health_group_id,
    health_probe_target: meta.health_probe_target
  };
}

export function resolveHealthGroup(row, config = {}) {
  const provider = row.provider;
  const providerConfig = config.providers?.[provider] ?? {};
  const primaryModel = providerConfig.model || "default";
  const primaryCanonical = `${provider}:${primaryModel}`;

  if (CLI_GROUP_PROVIDERS.has(provider)) {
    return {
      adapter: provider,
      health_group_id: `${provider}:primary`,
      health_probe_target: primaryCanonical
    };
  }

  if (
    LOCAL_GROUP_PROVIDERS.has(provider) ||
    provider.includes("local") ||
    provider.includes("ollama") ||
    row.local
  ) {
    return {
      adapter: provider,
      health_group_id: `${provider}:${row.model}`,
      health_probe_target: row.canonical_id
    };
  }

  if (provider === "openrouter") {
    return {
      adapter: "openrouter",
      health_group_id: "openrouter:candidates",
      health_probe_target: row.canonical_id
    };
  }

  // Direct API providers (openai, anthropic, http): per-model group by default
  return {
    adapter: provider,
    health_group_id: `${provider}:${row.model}`,
    health_probe_target: row.canonical_id
  };
}

export function usesPrimaryOnlyProbing(provider, config = {}) {
  const refresh = config?.routing?.smartRoute?.modelRefresh ?? {};
  if (refresh.probePrimaryOnly === false) {
    return false;
  }
  // Default true for CLI adapters and anything without clean per-model API execution
  if (CLI_GROUP_PROVIDERS.has(provider)) {
    return true;
  }
  if (provider === "openrouter") {
    return true;
  }
  return refresh.probePrimaryOnly === true;
}

/**
 * Select which models to direct-probe under primary-only mode.
 * Returns unique rows (by canonical_id) that should be probed.
 */
export function selectProbeTargets(models, config, options = {}) {
  const {
    previous = null,
    preliminaryRankings = {},
    topNPerTask = 1,
    probePrimaryOnly = true
  } = options;

  const byId = new Map(models.map((m) => [m.canonical_id, m]));
  const selected = new Map();

  const add = (canonicalId) => {
    const row = byId.get(canonicalId);
    if (row && !selected.has(canonicalId)) {
      selected.set(canonicalId, row);
    }
  };

  // Primary execution target per CLI / grouped adapter
  const providersSeen = new Set();
  for (const row of models) {
    const providerConfig = config.providers?.[row.provider];
    if (!providerConfig || providerConfig.enabled === false) {
      continue;
    }

    if (probePrimaryOnly && usesPrimaryOnlyProbing(row.provider, config)) {
      if (providersSeen.has(row.provider)) {
        continue;
      }
      providersSeen.add(row.provider);

      if (CLI_GROUP_PROVIDERS.has(row.provider)) {
        const target = row.health_probe_target ?? `${row.provider}:${providerConfig.model || "default"}`;
        add(target);
        // Fall back to first model in group if primary not in catalog
        if (!selected.has(target)) {
          const groupMate = models.find((m) => m.health_group_id === row.health_group_id);
          if (groupMate) {
            add(groupMate.canonical_id);
          }
        }
        continue;
      }

      if (row.provider === "openrouter") {
        // Only previous winners / top candidates (added below)
        continue;
      }
    }

    // Local / small catalogs: probe each configured model
    if (
      LOCAL_GROUP_PROVIDERS.has(row.provider) ||
      row.local ||
      row.provider.includes("local") ||
      row.provider.includes("ollama")
    ) {
      add(row.canonical_id);
      continue;
    }

    // Direct API without primary-only: probe configured models only
    if (!probePrimaryOnly) {
      add(row.canonical_id);
    } else if (!usesPrimaryOnlyProbing(row.provider, config)) {
      const primary = providerConfig.model;
      if (primary && row.model === primary) {
        add(row.canonical_id);
      }
    }
  }

  // Previous task winners
  for (const rows of Object.values(previous?.rankings ?? {})) {
    const winner = rows?.[0]?.canonical_id;
    if (winner) {
      add(winner);
    }
  }

  // Top N preliminary candidates per task
  for (const rows of Object.values(preliminaryRankings)) {
    for (const entry of (rows ?? []).slice(0, topNPerTask)) {
      if (entry?.canonical_id) {
        add(entry.canonical_id);
      }
    }
  }

  return [...selected.values()];
}

export function healthConfidenceForSource(source, priorCheckedAt = null, now = Date.now()) {
  if (source === "direct_probe") {
    return HEALTH_CONFIDENCE.direct_probe;
  }
  if (source === "inherited_group") {
    return HEALTH_CONFIDENCE.inherited_group;
  }
  if (source === "prior_snapshot") {
    if (!priorCheckedAt) {
      return HEALTH_CONFIDENCE.prior_snapshot_stale;
    }
    const ageHours = (now - Date.parse(priorCheckedAt)) / 3_600_000;
    return ageHours <= PRIOR_FRESH_HOURS
      ? HEALTH_CONFIDENCE.prior_snapshot_fresh
      : HEALTH_CONFIDENCE.prior_snapshot_stale;
  }
  return HEALTH_CONFIDENCE.unknown;
}

/**
 * Normalize health metadata for ranking. Legacy rows without health_source
 * but with measured rates are treated as prior_snapshot (confidence 0.7).
 */
export function resolveHealthMeta(health) {
  if (!health) {
    return { source: "unknown", confidence: HEALTH_CONFIDENCE.unknown };
  }
  if (health.health_source) {
    return {
      source: health.health_source,
      confidence:
        health.health_confidence ??
        healthConfidenceForSource(health.health_source, health.health_last_direct_probe ?? health.last_checked)
    };
  }
  // Legacy rows without source metadata: keep full confidence so older
  // snapshots remain rankable until the next primary-only refresh.
  if (health.success_rate_24h != null || health.response_ok != null) {
    return {
      source: "prior_snapshot",
      confidence: health.health_confidence ?? 1
    };
  }
  return { source: "unknown", confidence: HEALTH_CONFIDENCE.unknown };
}

export function effectiveReliability(health) {
  const measured = health?.success_rate_24h ?? health?.success_rate_7d ?? 0.75;
  const { confidence } = resolveHealthMeta(health);
  return measured * confidence;
}

export function requiresDirectHealth(taskType) {
  return HIGH_RISK_TASKS.has(taskType);
}

export function summarizeHealthCoverage(models) {
  let direct = 0;
  let inherited = 0;
  let prior = 0;
  let unknown = 0;

  for (const row of models) {
    const source = row.health?.health_source ?? "unknown";
    if (source === "direct_probe") {
      direct += 1;
    } else if (source === "inherited_group") {
      inherited += 1;
    } else if (source === "prior_snapshot") {
      prior += 1;
    } else {
      unknown += 1;
    }
  }

  return {
    total: models.length,
    direct_probe: direct,
    inherited_group: inherited,
    prior_snapshot: prior,
    unknown,
    direct_rate: models.length ? round(direct / models.length) : 0,
    known_rate: models.length ? round((direct + inherited + prior) / models.length) : 0
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
