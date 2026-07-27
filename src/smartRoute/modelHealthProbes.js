import fs from "node:fs/promises";
import path from "node:path";
import { runProvider } from "../cli.js";
import { classifyProviderRunResult } from "./providerResult.js";
import { PATHS } from "./modelSnapshotStore.js";
import { assertNotProductionWrite } from "./dataPaths.js";

import {
  attachHealthGroup,
  healthConfidenceForSource,
  selectProbeTargets,
  usesPrimaryOnlyProbing
} from "./modelHealthGroups.js";

export const PROBE_TEMPLATES = {
  chat: "Reply with exactly: pong",
  rewrite: "Rewrite professionally: hey can u send the file asap",
  summarize: "Summarize in one sentence: SmartRoute logs routing decisions daily.",
  extract_json: 'Return strict JSON only: {"status":"ok"}',
  code: "Write a JavaScript function add(a,b) that returns a+b. Code only.",
  code_debug: "Fix this bug: function add(a,b){ return a+b } // should add"
};

const HARD_EXCLUSION = {
  empty_response_rate: 0.05,
  timeout_rate: 0.1
};

export async function loadProviderHealthCache() {
  try {
    const raw = await fs.readFile(PATHS.providerHealth, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function saveProviderHealthCache(cache) {
  assertNotProductionWrite(PATHS.providerHealth);
  await fs.mkdir(path.dirname(PATHS.providerHealth), { recursive: true });
  await fs.writeFile(PATHS.providerHealth, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/** @deprecated Prefer selectProbeTargets + probeModelHealth({ probePrimaryOnly }) */
export function shouldProbeModel(row, config) {
  const providerConfig = config.providers?.[row.provider];
  if (!providerConfig?.enabled) {
    return false;
  }

  if (usesPrimaryOnlyProbing(row.provider, config)) {
    const primary = providerConfig.model || "default";
    return row.model === primary || (row.model === "default" && !providerConfig.model);
  }

  return true;
}

export function pickProviderProbeModel(models, config, provider) {
  const rows = models.filter((row) => row.provider === provider);
  const providerConfig = config.providers?.[provider];
  if (!rows.length || !providerConfig?.enabled) {
    return null;
  }
  const configured = [
    providerConfig.model,
    ...(providerConfig.models ?? []).map((m) => (typeof m === "string" ? m : m.id))
  ].filter(Boolean);
  for (const modelId of configured) {
    const match = rows.find((row) => row.model === modelId);
    if (match) {
      return match;
    }
  }
  return rows.find((row) => row.model === "default") ?? rows[0];
}

/**
 * Probe health for selected targets, inherit within health groups.
 *
 * @param {object[]} models
 * @param {object} config
 * @param {{
 *   quick?: boolean,
 *   probePrimaryOnly?: boolean,
 *   previous?: object|null,
 *   preliminaryRankings?: object,
 *   probeTargets?: object[],
 *   deadlineMs?: number|null,
 *   onProbe?: (info: object) => void
 * }} options
 */
export async function probeModelHealth(models, config, options = {}) {
  const {
    quick = false,
    probePrimaryOnly = true,
    previous = null,
    preliminaryRankings = {},
    probeTargets = null,
    deadlineMs = null,
    onProbe = null
  } = options;

  const prior = await loadProviderHealthCache();
  const next = { ...prior };
  // Primary-only uses a short probe set so refresh stays under maxRefreshSeconds.
  const probes = quick
    ? ["chat"]
    : probePrimaryOnly
      ? ["chat", "extract_json"]
      : Object.keys(PROBE_TEMPLATES);
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const withGroups = models.map((row) => attachHealthGroup(row, config));

  const targets =
    probeTargets ??
    selectProbeTargets(withGroups, config, {
      previous,
      preliminaryRankings,
      topNPerTask: 1,
      probePrimaryOnly
    });

  const directByCanonical = new Map();
  const directByGroup = new Map();
  let timedOut = false;
  let probesRun = 0;

  for (const row of targets) {
    if (deadlineMs != null && Date.now() > deadlineMs) {
      timedOut = true;
      break;
    }

    const providerConfig = config.providers?.[row.provider];
    if (!providerConfig?.enabled) {
      continue;
    }

    const history = prior[row.canonical_id]?.history ?? [];
    const probeResults = [];

    for (const probeType of probes) {
      if (deadlineMs != null && Date.now() > deadlineMs) {
        timedOut = true;
        break;
      }

      const started = Date.now();
      try {
        const result = await runProvider(
          row.provider,
          {
            ...providerConfig,
            model: row.model === "default" ? providerConfig.model : row.model,
            timeoutMs: Math.min(providerConfig.timeoutMs ?? 90_000, 90_000)
          },
          PROBE_TEMPLATES[probeType]
        );
        const check = classifyProviderRunResult(result, null, {
          requireContent: probeType !== "extract_json"
        });
        probeResults.push({
          probe: probeType,
          ok: check.ok,
          latency_ms: Date.now() - started,
          failure_category: check.failure_category
        });
      } catch (error) {
        const check = classifyProviderRunResult({}, error, { requireContent: true });
        probeResults.push({
          probe: probeType,
          ok: false,
          latency_ms: Date.now() - started,
          failure_category: check.failure_category
        });
      }
    }

    if (!probeResults.length) {
      continue;
    }

    probesRun += 1;
    const health = annotateHealth(
      aggregateHealth(probeResults, history, now),
      {
        source: "direct_probe",
        groupId: row.health_group_id,
        probeTarget: row.canonical_id,
        directProbeAt: now
      }
    );

    next[row.canonical_id] = {
      ...health,
      history: trimHistory([...history, { at: now, probes: probeResults }])
    };
    directByCanonical.set(row.canonical_id, health);
    if (row.health_group_id) {
      directByGroup.set(row.health_group_id, {
        health,
        probeTarget: row.canonical_id
      });
    }

    if (onProbe) {
      onProbe({
        canonical_id: row.canonical_id,
        health_group_id: row.health_group_id,
        ok: health.response_ok,
        probes_run: probesRun
      });
    }
  }

  const enriched = distributeHealthResults(withGroups, {
    config,
    directByCanonical,
    directByGroup,
    priorCache: prior,
    previous,
    now,
    nowMs
  });

  await saveProviderHealthCache(next);

  return {
    models: enriched,
    probes_run: probesRun,
    targets_selected: targets.length,
    timed_out: timedOut,
    direct_probe_ids: [...directByCanonical.keys()]
  };
}

/**
 * Apply direct probe results + group inheritance + prior snapshot fallback.
 * Pure (aside from config lookups) — used by probes and unit tests.
 */
export function distributeHealthResults(models, options = {}) {
  const {
    config = {},
    directByCanonical = new Map(),
    directByGroup = new Map(),
    priorCache = {},
    previous = null,
    now = new Date().toISOString(),
    nowMs = Date.now()
  } = options;

  const priorById = new Map((previous?.models ?? []).map((m) => [m.canonical_id, m]));

  return models.map((row) => {
    const providerConfig = config.providers?.[row.provider];
    if (providerConfig && providerConfig.enabled === false) {
      const health = annotateHealth(inactiveHealth(now), {
        source: "unknown",
        groupId: row.health_group_id,
        probeTarget: row.health_probe_target
      });
      return { ...row, health, health_excluded: true, health_probed: false };
    }

    const direct = directByCanonical.get(row.canonical_id);
    if (direct) {
      return {
        ...row,
        health: direct,
        health_excluded: shouldExcludeHealth(direct, row),
        health_probed: true
      };
    }

    const groupHit = row.health_group_id ? directByGroup.get(row.health_group_id) : null;
    if (groupHit) {
      const health = annotateHealth(
        { ...groupHit.health, health_inherited: true },
        {
          source: "inherited_group",
          groupId: row.health_group_id,
          probeTarget: groupHit.probeTarget,
          directProbeAt: groupHit.health.health_last_direct_probe
        }
      );
      return {
        ...row,
        health,
        health_excluded: shouldExcludeHealth(health, row),
        health_probed: false
      };
    }

    const prev = priorById.get(row.canonical_id) ?? priorCache[row.canonical_id];
    const prevHealth = prev?.health ?? (prev?.success_rate_24h != null ? prev : null);
    if (prevHealth && (prevHealth.success_rate_24h != null || prevHealth.response_ok != null)) {
      const health = annotateHealth(
        {
          reachable: prevHealth.reachable ?? true,
          response_ok: prevHealth.response_ok ?? true,
          success_rate_24h: prevHealth.success_rate_24h ?? 0.75,
          success_rate_7d: prevHealth.success_rate_7d ?? prevHealth.success_rate_24h ?? 0.75,
          empty_response_rate: prevHealth.empty_response_rate ?? 0,
          timeout_rate: prevHealth.timeout_rate ?? 0,
          provider_error_rate: prevHealth.provider_error_rate ?? 0,
          avg_latency_ms: prevHealth.avg_latency_ms ?? null,
          p95_latency_ms: prevHealth.p95_latency_ms ?? null,
          last_probe_status: prevHealth.last_probe_status ?? "prior",
          last_failure_category: prevHealth.last_failure_category ?? null,
          last_checked: now
        },
        {
          source: "prior_snapshot",
          groupId: row.health_group_id,
          probeTarget: row.health_probe_target,
          directProbeAt: prevHealth.health_last_direct_probe ?? prevHealth.last_checked,
          priorCheckedAt: prevHealth.last_checked ?? prevHealth.health_last_direct_probe,
          nowMs
        }
      );
      return {
        ...row,
        health,
        health_excluded: shouldExcludeHealth(health, row),
        health_probed: false
      };
    }

    const health = annotateHealth(defaultUnprobedHealth(now), {
      source: "unknown",
      groupId: row.health_group_id,
      probeTarget: row.health_probe_target
    });
    return {
      ...row,
      health,
      health_excluded: shouldExcludeHealth(health, row),
      health_probed: false
    };
  });
}

/**
 * Direct-probe additional models (probe expansion) and merge into existing list.
 */
export async function probeAdditionalModels(models, extraTargets, config, options = {}) {
  const { quick = false, deadlineMs = null } = options;
  if (!extraTargets.length) {
    return { models, probes_run: 0, timed_out: false };
  }

  const result = await probeModelHealth(models, config, {
    quick,
    probePrimaryOnly: false,
    probeTargets: extraTargets,
    deadlineMs,
    previous: { models }
  });

  // Prefer direct probes; never downgrade an existing direct_probe to inherited.
  const byId = new Map(result.models.map((m) => [m.canonical_id, m]));
  const merged = models.map((row) => {
    const updated = byId.get(row.canonical_id);
    if (!updated) {
      return row;
    }
    if (row.health?.health_source === "direct_probe") {
      return row;
    }
    if (updated.health?.health_source === "direct_probe") {
      return updated;
    }
    // Refresh group inheritance from newly probed targets only when not already direct
    if (
      updated.health?.health_source === "inherited_group" &&
      result.direct_probe_ids.some((id) => {
        const probed = byId.get(id);
        return probed?.health_group_id === row.health_group_id;
      })
    ) {
      return updated;
    }
    return row;
  });

  return {
    models: merged,
    probes_run: result.probes_run,
    timed_out: result.timed_out,
    direct_probe_ids: result.direct_probe_ids
  };
}

function annotateHealth(base, { source, groupId, probeTarget, directProbeAt = null, priorCheckedAt = null, nowMs = Date.now() }) {
  return {
    ...base,
    health_source: source,
    health_group_id: groupId ?? null,
    health_probe_target: probeTarget ?? null,
    health_last_direct_probe: directProbeAt ?? null,
    health_confidence: healthConfidenceForSource(source, priorCheckedAt ?? directProbeAt, nowMs),
    health_inherited: source === "inherited_group"
  };
}

function defaultUnprobedHealth(now) {
  return {
    reachable: true,
    response_ok: true,
    success_rate_24h: 0.75,
    success_rate_7d: 0.75,
    empty_response_rate: 0,
    timeout_rate: 0,
    provider_error_rate: 0,
    avg_latency_ms: null,
    p95_latency_ms: null,
    last_probe_status: "skipped",
    last_failure_category: null,
    last_checked: now,
    health_inherited: false
  };
}

function aggregateHealth(probeResults, history, now) {
  const okCount = probeResults.filter((p) => p.ok).length;
  const total = probeResults.length || 1;
  const latencies = probeResults.map((p) => p.latency_ms).filter((n) => n != null);
  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;

  const recent = history.slice(-20);
  const flat = recent.flatMap((h) => h.probes ?? []);
  const successRate = flat.length
    ? flat.filter((p) => p.ok).length / flat.length
    : okCount / total;
  const emptyRate = flat.filter((p) => p.failure_category === "empty_stdout").length / Math.max(flat.length, 1);
  const timeoutRate = flat.filter((p) => p.failure_category === "timeout").length / Math.max(flat.length, 1);
  const errorRate = flat.filter((p) => !p.ok).length / Math.max(flat.length, 1);

  const lastFail = probeResults.find((p) => !p.ok);

  return {
    reachable: okCount > 0,
    response_ok: okCount === total,
    success_rate_24h: successRate,
    success_rate_7d: successRate,
    empty_response_rate: emptyRate,
    timeout_rate: timeoutRate,
    provider_error_rate: errorRate,
    avg_latency_ms: avg,
    p95_latency_ms: p95,
    last_probe_status: okCount === total ? "pass" : okCount > 0 ? "partial" : "fail",
    last_failure_category: lastFail?.failure_category ?? null,
    last_checked: now
  };
}

function inactiveHealth(now) {
  return {
    reachable: false,
    response_ok: false,
    success_rate_24h: 0,
    success_rate_7d: 0,
    empty_response_rate: 1,
    timeout_rate: 0,
    provider_error_rate: 1,
    avg_latency_ms: null,
    p95_latency_ms: null,
    last_probe_status: "fail",
    last_failure_category: "provider_disabled",
    last_checked: now
  };
}

export function shouldExcludeHealth(health, row) {
  if (!health?.response_ok && health?.last_probe_status === "fail") {
    return true;
  }
  if ((health?.empty_response_rate ?? 0) > HARD_EXCLUSION.empty_response_rate) {
    return true;
  }
  if ((health?.timeout_rate ?? 0) > HARD_EXCLUSION.timeout_rate) {
    return true;
  }
  if (row.available === false) {
    return true;
  }
  return false;
}

function trimHistory(history, max = 48) {
  return history.slice(-max);
}
