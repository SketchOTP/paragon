import crypto from "node:crypto";
import { discoverModels } from "./modelDiscovery.js";
import { enrichModelPricing, summarizePricingCoverage } from "./modelPricing.js";
import { enrichModelBenchmarks } from "./modelBenchmarks.js";
import { probeAdditionalModels, probeModelHealth } from "./modelHealthProbes.js";
import { attachHealthGroup, summarizeHealthCoverage } from "./modelHealthGroups.js";
import {
  rankAllTasks,
  rankModelsForTask,
  scoreModelForTask,
  TASK_FLOORS
} from "./modelRanker.js";
import {
  appendRefreshLog,
  mergeModelRefreshConfig,
  readCurrentSnapshot,
  writeCurrentSnapshot
} from "./modelSnapshotStore.js";
import { loadResearchCatalog } from "./researchAgent/researchCatalog.js";


let refreshInFlight = null;
let lastRefreshResult = null;

export async function runModelIntelligenceRefresh(config, options = {}) {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const refreshConfig = mergeModelRefreshConfig(config?.routing?.smartRoute ?? {});
  const quick = options.quick === true;
  const probe = options.probe !== false && refreshConfig.requireHealthProbes;
  const probePrimaryOnly =
    options.probePrimaryOnly !== undefined
      ? options.probePrimaryOnly
      : refreshConfig.probePrimaryOnly !== false;
  const maxRefreshMs = (refreshConfig.maxRefreshSeconds ?? 300) * 1000;
  const expansion = {
    enabled: true,
    topBlockedPerTask: 1,
    maxAdditionalProbes: 12,
    maxProbeSeconds: 300,
    ...(refreshConfig.healthProbeExpansion ?? {})
  };

  refreshInFlight = (async () => {
    const started = Date.now();
    const deadlineMs = started + maxRefreshMs;
    const previous = await readCurrentSnapshot();
    let stage = "discovery";
    let models = [];
    let healthMeta = { probes_run: 0, timed_out: false, expansion_probes: 0 };

    try {
      if (refreshConfig.requireProviderDiscovery !== false) {
        // Never probe during discovery when primary-only — health stage owns probes
        models = await discoverModels(config, { probe: false });
      }

      if (Date.now() > deadlineMs) {
        return await preservePartial(previous, "discovery", "refresh_deadline_exceeded", started);
      }

      stage = "pricing";
      if (refreshConfig.requirePricingRefresh !== false) {
        models = await enrichModelPricing(models, config, {
          forcePricingCatalog: !quick
        });
      }

      stage = "benchmarks";
      if (refreshConfig.requireBenchmarkRefresh !== false) {
        models = await enrichModelBenchmarks(models);
      }

      models = models.map((row) => attachHealthGroup(row, config));

      // Attach prior health for preliminary rankings
      models = attachPriorHealth(models, previous);

      stage = "health";
      if (probe) {
        const preliminaryRankings = rankAllTasks(models, Object.keys(TASK_FLOORS), {
          costSensitive: true,
          mode: "balanced",
          smartRoute: { ...(config?.routing?.smartRoute ?? {}), mode: "balanced" },
          config
        });

        const healthResult = await probeModelHealth(models, config, {
          quick,
          probePrimaryOnly,
          previous,
          preliminaryRankings,
          deadlineMs
        });
        models = healthResult.models;
        healthMeta.probes_run = healthResult.probes_run;
        healthMeta.timed_out = healthResult.timed_out;
        healthMeta.targets_selected = healthResult.targets_selected;
        healthMeta.direct_probe_ids = healthResult.direct_probe_ids;

        if (healthResult.timed_out) {
          return await preservePartial(previous, "health", "refresh_deadline_exceeded", started, {
            health_meta: healthMeta
          });
        }

        if (expansion.enabled !== false) {
          const expandResult = await expandBlockedProbes(models, config, {
            quick,
            expansion,
            deadlineMs: Math.min(deadlineMs, Date.now() + expansion.maxProbeSeconds * 1000)
          });
          models = expandResult.models;
          healthMeta.expansion_probes = expandResult.probes_run;
          healthMeta.probes_run += expandResult.probes_run;
          healthMeta.timed_out = healthMeta.timed_out || expandResult.timed_out;

          if (expandResult.timed_out && !hasAcceptableCheapTaskWinners(models)) {
            return await preservePartial(previous, "health_expansion", "refresh_deadline_exceeded", started, {
              health_meta: healthMeta
            });
          }
        }
      } else {
        models = attachPriorHealth(models, previous);
      }

      stage = "rankings";
      const rankings = rankAllTasks(models, Object.keys(TASK_FLOORS), {
        mode: "balanced",
        smartRoute: {
          ...(config?.routing?.smartRoute ?? {}),
          mode: "balanced"
        },
        config
      });
      const changes = detectChanges(previous, models, rankings);
      const pricing_coverage = summarizePricingCoverage(models);
      const health_coverage = summarizeHealthCoverage(models);
      const researchCatalog = await loadResearchCatalog().catch(() => null);
      const research_hash = researchCatalog?.research_hash ?? null;
      const intelligence_hash = hashIntelligenceSnapshot({ models, rankings, research_hash });

      const snapshot = {
        version: 1,
        generated_at: new Date().toISOString(),
        stale: false,
        refresh_status: "ok",
        refresh_duration_ms: Date.now() - started,
        probe_primary_only: probePrimaryOnly,
        health_meta: healthMeta,
        models,
        rankings,
        changes,
        pricing_coverage,
        health_coverage,
        research_hash,
        intelligence_hash,
        providers_summary: summarizeProviders(models)
      };

      await writeCurrentSnapshot(snapshot);
      lastRefreshResult = { ok: true, snapshot, changes };
      await appendRefreshLog({
        status: "ok",
        stage,
        model_count: models.length,
        duration_ms: snapshot.refresh_duration_ms,
        pricing_coverage,
        health_coverage,
        health_meta: healthMeta,
        probe_primary_only: probePrimaryOnly,
        changes
      });
      return lastRefreshResult;
    } catch (error) {
      const failSnapshot = previous
        ? {
            ...previous,
            stale: true,
            refresh_status: "failed",
            last_error: error.message,
            last_refresh_attempt: new Date().toISOString()
          }
        : null;

      if (failSnapshot) {
        await writeCurrentSnapshot(failSnapshot);
      }

      lastRefreshResult = { ok: false, error: error.message, stage, preserved: Boolean(previous) };
      await appendRefreshLog({
        status: "failed",
        stage,
        error: error.message,
        preserved_previous: Boolean(previous)
      });
      return lastRefreshResult;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function preservePartial(previous, stage, reason, started, extra = {}) {
  if (previous?.refresh_status === "ok" && previous?.models?.length) {
    const preserved = {
      ...previous,
      stale: true,
      refresh_status: "partial",
      last_error: reason,
      last_refresh_attempt: new Date().toISOString(),
      last_partial_stage: stage,
      ...extra
    };
    await writeCurrentSnapshot(preserved);
    lastRefreshResult = {
      ok: false,
      partial: true,
      error: reason,
      stage,
      preserved: true,
      snapshot: preserved
    };
    await appendRefreshLog({
      status: "partial",
      stage,
      error: reason,
      preserved_previous: true,
      duration_ms: Date.now() - started,
      ...extra
    });
    return lastRefreshResult;
  }

  lastRefreshResult = { ok: false, partial: true, error: reason, stage, preserved: false };
  await appendRefreshLog({
    status: "partial",
    stage,
    error: reason,
    preserved_previous: false,
    duration_ms: Date.now() - started
  });
  return lastRefreshResult;
}

function attachPriorHealth(models, previous) {
  const priorById = new Map((previous?.models ?? []).map((m) => [m.canonical_id, m]));
  const now = new Date().toISOString();

  return models.map((row) => {
    if (row.health?.health_source && row.health.health_source !== "unknown") {
      return row;
    }
    const prev = priorById.get(row.canonical_id);
    if (!prev?.health) {
      return {
        ...row,
        health: {
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
          health_source: "unknown",
          health_group_id: row.health_group_id,
          health_probe_target: row.health_probe_target,
          health_last_direct_probe: null,
          health_confidence: 0,
          health_inherited: false
        },
        health_excluded: false,
        health_probed: false
      };
    }

    const ageHours = prev.health.last_checked
      ? (Date.now() - Date.parse(prev.health.last_checked)) / 3_600_000
      : 999;
    const confidence = ageHours <= 36 ? 0.7 : 0.4;

    return {
      ...row,
      health: {
        ...prev.health,
        last_checked: now,
        health_source: "prior_snapshot",
        health_group_id: row.health_group_id ?? prev.health.health_group_id,
        health_probe_target: row.health_probe_target ?? prev.health.health_probe_target,
        health_last_direct_probe: prev.health.health_last_direct_probe ?? prev.health.last_checked,
        health_confidence: confidence,
        health_inherited: false
      },
      health_excluded: prev.health_excluded ?? false,
      health_probed: false
    };
  });
}

async function expandBlockedProbes(models, config, { quick, expansion, deadlineMs }) {
  let current = models;
  let probesRun = 0;
  let timedOut = false;
  const probed = new Set(models.filter((m) => m.health?.health_source === "direct_probe").map((m) => m.canonical_id));

  while (probesRun < expansion.maxAdditionalProbes) {
    if (deadlineMs != null && Date.now() > deadlineMs) {
      timedOut = true;
      break;
    }

    const blocked = findTopBlockedCandidates(current, expansion.topBlockedPerTask ?? 1);
    const toProbe = blocked.filter((m) => !probed.has(m.canonical_id));
    if (!toProbe.length) {
      break;
    }

    const batch = toProbe.slice(0, Math.min(toProbe.length, expansion.maxAdditionalProbes - probesRun));
    for (const row of batch) {
      probed.add(row.canonical_id);
    }

    const result = await probeAdditionalModels(current, batch, config, { quick, deadlineMs });
    current = result.models;
    probesRun += result.probes_run;
    timedOut = timedOut || result.timed_out;

    if (hasAcceptableCheapTaskWinners(current)) {
      break;
    }
    if (result.probes_run === 0) {
      break;
    }
  }

  return { models: current, probes_run: probesRun, timed_out: timedOut };
}

function findTopBlockedCandidates(models, perTask) {
  const selected = new Map();

  for (const taskType of Object.keys(TASK_FLOORS)) {
    const scored = models
      .map((model) => ({
        model,
        ranking: scoreModelForTask(model, taskType, { costSensitive: true })
      }))
      .sort((a, b) => {
        // Prefer near-misses: high quality * measured reliability / cost
        const scoreA =
          (a.model.benchmarks ? 1 : 0.5) *
          (a.ranking.measured_reliability ?? 0.75) /
          Math.max(a.ranking.effective_cost ?? 1, 1e-9);
        const scoreB =
          (b.model.benchmarks ? 1 : 0.5) *
          (b.ranking.measured_reliability ?? 0.75) /
          Math.max(b.ranking.effective_cost ?? 1, 1e-9);
        return scoreB - scoreA;
      });

    const passing = scored.filter((r) => r.ranking.pass);
    if (passing.length) {
      continue;
    }

    let added = 0;
    for (const row of scored) {
      const reason = row.ranking.reason ?? "";
      if (
        reason.includes("health") ||
        reason.includes("reliability") ||
        reason === "unknown_health"
      ) {
        if (!selected.has(row.model.canonical_id)) {
          selected.set(row.model.canonical_id, row.model);
          added += 1;
        }
        if (added >= perTask) {
          break;
        }
      }
    }
  }

  return [...selected.values()];
}

function hasAcceptableCheapTaskWinners(models) {
  const cheap = ["chat", "rewrite", "summarize", "extract_json"];
  for (const taskType of cheap) {
    const ranked = rankModelsForTask(models, taskType, { costSensitive: true });
    if (!ranked.length) {
      return false;
    }
    const winner = ranked[0].model;
    if (!winner.health || winner.health.health_source === "unknown") {
      return false;
    }
  }
  return true;
}

export function getLastRefreshResult() {
  return lastRefreshResult;
}

export function detectChanges(previous, models, rankings) {
  const prevIds = new Set((previous?.models ?? []).map((m) => m.canonical_id));
  const nextIds = new Set(models.map((m) => m.canonical_id));

  const new_models = models.filter((m) => !prevIds.has(m.canonical_id)).map((m) => m.canonical_id);
  const removed_models = [...prevIds].filter((id) => !nextIds.has(id));

  const price_changes = [];
  const benchmark_changes = [];
  const health_changes = [];
  const ranking_changes = [];

  for (const model of models) {
    const prev = previous?.models?.find((m) => m.canonical_id === model.canonical_id);
    if (!prev) continue;

    const oldIn = prev.pricing?.input_per_1m;
    const newIn = model.pricing?.input_per_1m;
    if (oldIn != null && newIn != null && oldIn > 0) {
      const delta = (newIn - oldIn) / oldIn;
      if (Math.abs(delta) >= 0.01) {
        price_changes.push({
          canonical_id: model.canonical_id,
          field: "input_per_1m",
          old: oldIn,
          new: newIn,
          delta_pct: round(delta * 100)
        });
      }
    }

    const oldSwe = prev.benchmarks?.swe_bench_verified_resolved;
    const newSwe = model.benchmarks?.swe_bench_verified_resolved;
    if (oldSwe != null && newSwe != null && Math.abs(newSwe - oldSwe) >= 1) {
      benchmark_changes.push({
        canonical_id: model.canonical_id,
        field: "swe_bench_verified_resolved",
        old: oldSwe,
        new: newSwe
      });
    }

    const oldHealth = prev.health?.response_ok;
    const newHealth = model.health?.response_ok;
    if (oldHealth !== newHealth) {
      health_changes.push({
        canonical_id: model.canonical_id,
        old: oldHealth,
        new: newHealth,
        failure_category: model.health?.last_failure_category
      });
    }
  }

  for (const taskType of Object.keys(rankings ?? {})) {
    const prevTop = previous?.rankings?.[taskType]?.[0]?.canonical_id;
    const nextTop = rankings[taskType]?.[0]?.canonical_id;
    if (prevTop && nextTop && prevTop !== nextTop) {
      ranking_changes.push({ task_type: taskType, old: prevTop, new: nextTop });
    }
  }

  const changes = {
    new_models,
    removed_models,
    price_changes,
    benchmark_changes,
    health_changes,
    ranking_changes
  };

  return {
    ...changes,
    critical_alerts: buildCriticalAlerts(changes, rankings)
  };
}

function buildCriticalAlerts(changes, rankings) {
  const alerts = [];
  for (const row of changes.price_changes ?? []) {
    if (row.delta_pct > 25) {
      alerts.push({ type: "price_increase", canonical_id: row.canonical_id, delta_pct: row.delta_pct });
    }
  }
  for (const row of changes.health_changes ?? []) {
    if (row.new === false) {
      alerts.push({ type: "health_failure", canonical_id: row.canonical_id });
    }
  }
  for (const [taskType, rows] of Object.entries(rankings ?? {})) {
    if (!rows?.length) {
      alerts.push({ type: "no_model_passes_floor", task_type: taskType });
    }
  }
  return alerts;
}

function summarizeProviders(models) {
  const summary = {};
  for (const row of models) {
    summary[row.provider] = summary[row.provider] ?? { count: 0, available: 0 };
    summary[row.provider].count += 1;
    if (row.available !== false) summary[row.provider].available += 1;
  }
  return summary;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function hashIntelligenceSnapshot({ models, rankings, research_hash }) {
  const payload = JSON.stringify({
    research_hash,
    model_ids: (models ?? []).map((m) => m.canonical_id).sort(),
    pricing: (models ?? []).map((m) => ({
      id: m.canonical_id,
      in: m.pricing?.input_per_1m,
      out: m.pricing?.output_per_1m,
      status: m.pricing?.pricing_status,
      source: m.pricing?.pricing_source,
      hash: m.pricing?.source_hash
    })),
    winners: Object.fromEntries(
      Object.entries(rankings ?? {}).map(([task, rows]) => [task, rows?.[0]?.canonical_id ?? null])
    )
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}
