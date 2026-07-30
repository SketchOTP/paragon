import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_FLOWS } from "./authFlows.js";
import { createAuthMiddleware } from "./auth.js";
import { dataDir, readConfig, writeConfig } from "./configStore.js";
import { getEnv } from "./env.js";
import { getLogs, subscribeLogs, addLog } from "./logStore.js";
import { registerOpenAiRoutes } from "./openaiApi.js";
import { getAuthSession, getAuthState, listModels, runStatus, startAuth, submitAuthCode } from "./cli.js";
import { tailscaleUrls } from "./tailscaleUrls.js";
import { createOrchestrationRuntime } from "./orchestration/telemetry.js";
import { registerOrchestrationRoutes } from "./orchestration/api.js";
import { buildModelRegistry } from "./routing/modelRegistry.js";
import { rankRegistryByTask, scoringMethodology, TASK_TYPES } from "./routing/router.js";
import { getBenchmarkData, annotateRegistryWithBenchmarks } from "./routing/benchmarks.js";
import { applyExecutionResult, loadCatalog, reconcileConfiguredModels, saveCatalog } from "./modelCatalog.js";
import { defaultProbe, runFullRefresh, refreshProviderCatalog } from "./modelCatalogRefresh.js";
import { startModelCatalogScheduler } from "./modelCatalogScheduler.js";
import { loadTelemetry, saveTelemetry, recordOutcome as recordTelemetryOutcome, pruneTelemetry } from "./routing/outcomeTelemetry.js";
import { createShadowStore } from "./routing/shadowStore.js";
import { computeShadowRoute } from "./routing/shadowEngine.js";
import { buildTaskProfile } from "./routing/taskProfile.js";
import { providerGrammarSummary } from "./routing/executionProfile.js";
import { createRouteActivityStore } from "./routing/routeActivity.js";
import { buildProviderRoutingSummaries } from "./routing/providerSummary.js";
import { ACTIVE_BUT_MISREPRESENTED_FIELDS, DEPRECATED_CONFIG_FIELDS } from "./deprecatedConfig.js";
import { AVATAR_DIR, AVATAR_ROUTE, removeProviderAvatar, saveProviderAvatar } from "./providerAvatars.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedConfig = await readConfig();
let cachedCatalog = await loadCatalog();

// PARAGON-D-004C: single in-process view of the persisted model catalog.
// recordResult() is the immediate-exclusion feedback path — a request that
// fails with a model-specific classification updates the shared in-memory
// catalog (and persists it) before the *next* request is routed, without
// waiting for the next scheduled refresh.
const catalogStore = {
  get: () => cachedCatalog,
  async recordResult(provider, modelId, resultInfo) {
    applyExecutionResult(cachedCatalog, provider, modelId, resultInfo);
    await saveCatalog(cachedCatalog);
    return cachedCatalog;
  }
};

/**
 * PARAGON-D-004C1 (P0-3): clears any `config.providers[x].model` that the
 * catalog no longer considers eligible, and persists atomically. Runs at
 * startup (so models made stale before this code existed are cleaned up
 * too) and after every catalog refresh. Never substitutes a replacement
 * model — see reconcileConfiguredModels().
 */
async function reconcileConfigWithCatalog(reason) {
  const { config: nextConfig, cleared } = reconcileConfiguredModels(cachedConfig, cachedCatalog, {
    ttlHours: cachedConfig.modelCatalog?.validationTtlHours ?? 24
  });
  if (!cleared.length) {
    return cleared;
  }
  cachedConfig = await writeConfig(nextConfig);
  for (const entry of cleared) {
    addLog({
      type: "models",
      provider: entry.provider,
      level: "warn",
      message: `routing.configuredModelCleared: "${entry.model}" (catalog state: ${entry.previousState}) cleared from provider config during ${reason}`
    });
  }
  return cleared;
}

/**
 * PARAGON-D-004D runtime (Phase 12). Shadow-only: it computes the new
 * ranking and accumulates outcome telemetry, but nothing here participates
 * in live provider or model selection while `mode` is "shadow".
 */
let cachedTelemetry = await loadTelemetry();
{
  const settings = cachedConfig.routingIntelligence ?? {};
  const { removed } = pruneTelemetry(cachedTelemetry, { retentionDays: settings.telemetryRetentionDays ?? 30 });
  if (removed) {
    await saveTelemetry(cachedTelemetry).catch(() => {});
  }
}

// Telemetry writes are debounced: observations land in memory immediately and
// are flushed on a timer, so the request path never waits on disk I/O.
let telemetryDirty = false;
const telemetryFlushTimer = setInterval(() => {
  if (!telemetryDirty) return;
  telemetryDirty = false;
  saveTelemetry(cachedTelemetry).catch((error) => {
    console.warn(`routing telemetry: flush failed (non-fatal): ${error.message}`);
  });
}, 30_000);
telemetryFlushTimer.unref?.();

/**
 * PARAGON-D-004D1: observed routing activity, so the dashboard can show the
 * model each provider actually ran last (and what shadow would have picked)
 * instead of the deprecated configured-model preference. Instrumentation
 * only — nothing here is read by a routing decision.
 */
const routeActivity = createRouteActivityStore();

const routingIntelligence = {
  get settings() {
    return cachedConfig.routingIntelligence ?? {};
  },
  routeActivity,
  shadowStore: createShadowStore({ limit: cachedConfig.routingIntelligence?.shadowRecordLimit ?? 200 }),
  getTelemetry: () => cachedTelemetry,
  recordOutcome(observation) {
    if (this.settings.enabled === false) {
      return;
    }
    try {
      recordTelemetryOutcome(cachedTelemetry, observation);
      telemetryDirty = true;
    } catch (error) {
      console.warn(`routing telemetry: record failed (non-fatal): ${error.message}`);
    }
  }
};

const modelCatalogScheduler = startModelCatalogScheduler(async () => cachedConfig, {
  onRefreshComplete: async (result) => {
    if (result?.catalog) {
      cachedCatalog = result.catalog;
    }
    await reconcileConfigWithCatalog("scheduled catalog refresh").catch((error) => {
      console.warn(`model catalog: config reconciliation failed (non-fatal): ${error.message}`);
    });
  }
});

// Startup reconciliation: catches configured models that went stale before
// this implementation existed, without waiting for the next refresh cycle.
await reconcileConfigWithCatalog("startup reconciliation").catch((error) => {
  console.warn(`model catalog: startup config reconciliation failed (non-fatal): ${error.message}`);
});
// Registering a SIGTERM/SIGINT listener replaces Node's default
// terminate-immediately behavior, so each handler must explicitly exit —
// otherwise `kill`/systemd stop would leave the process running forever.
process.on("SIGTERM", () => {
  modelCatalogScheduler.stop();
  clearInterval(telemetryFlushTimer);
  process.exit(0);
});
process.on("SIGINT", () => {
  modelCatalogScheduler.stop();
  clearInterval(telemetryFlushTimer);
  process.exit(0);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));
// Operator-uploaded provider avatars (PARAGON-D-004D1). Bundled avatars ship
// under public/avatars/; these are the per-deployment overrides.
app.use(AVATAR_ROUTE, express.static(AVATAR_DIR));

const getConfig = async () => cachedConfig;
const adminAuth = createAuthMiddleware(getConfig, { allowLocalhost: true });

const orchestration = createOrchestrationRuntime({
  dataDir,
  getPolicy: () => cachedConfig.orchestration
});
orchestration.startRetentionScheduler();

const STATUS_CACHE_MS = 15000;
let statusSnapshot = { at: 0, body: null };

async function collectProviderStatuses(config, { quiet = true } = {}) {
  return Promise.all(
    Object.entries(config.providers).map(async ([provider, providerConfig]) => {
      try {
        const result = await runStatus(provider, providerConfig, { quiet });
        return {
          provider,
          ok: true,
          output: result.stdout || result.stderr
        };
      } catch (error) {
        if (!quiet) {
          addLog({
            type: "status",
            provider,
            level: "warn",
            message: error.stderr || error.message
          });
        }
        return {
          provider,
          ok: false,
          output: error.stderr || error.message
        };
      }
    })
  );
}

function invalidateStatusCache() {
  statusSnapshot = { at: 0, body: null };
}

/**
 * Reuses the same cached status snapshot the dashboard already warms via
 * /api/status — the router (D-004) needs a health signal per request but
 * must never trigger a fresh CLI spawn per chat completion. Returns {}
 * (all providers "unknown" health) until the cache has been warmed once.
 */
function getStatuses() {
  const statuses = {};
  for (const entry of statusSnapshot.body?.statuses ?? []) {
    statuses[entry.provider] = { ok: entry.ok };
  }
  return statuses;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", adminAuth);

app.get("/api/config", async (_req, res) => {
  res.json(await getConfig());
});

app.put("/api/config", async (req, res) => {
  const previousProviders = new Set(Object.keys(cachedConfig.providers ?? {}));
  cachedConfig = await writeConfig(req.body);
  res.json(cachedConfig);

  // PARAGON-D-004C1 (P0-4): a newly enabled provider is `pending_assessment`
  // and contributes nothing routable until real discovery succeeds — so kick
  // off a bounded refresh for it immediately rather than leaving it dark
  // until the next 24h cycle. Fire-and-forget: the operator's config write
  // has already been acknowledged above, and a discovery failure correctly
  // leaves the provider unavailable rather than trusted.
  const newlyEnabled = Object.entries(cachedConfig.providers ?? {})
    .filter(([name, cfg]) => cfg.enabled && (!previousProviders.has(name) || !cachedCatalog.providers?.[name]))
    .map(([name]) => name);
  for (const provider of newlyEnabled) {
    const providerConfig = cachedConfig.providers[provider];
    const settings = cachedConfig.modelCatalog ?? {};
    if (settings.enabled === false) {
      continue;
    }
    refreshProviderCatalog(provider, providerConfig, cachedCatalog, {
      maxValidationProbesPerProvider: settings.maxValidationProbesPerProvider ?? 10
    })
      .then(async () => {
        await saveCatalog(cachedCatalog);
        await reconcileConfigWithCatalog(`initial assessment of ${provider}`);
        addLog({ type: "models", provider, level: "info", message: "Initial model-catalog assessment complete" });
      })
      .catch((error) => {
        addLog({
          type: "models",
          provider,
          level: "warn",
          message: `routing.providerPendingAssessment: initial assessment failed, provider stays unavailable (not trusted): ${error.message}`
        });
      });
  }
});

app.get("/api/status", async (req, res) => {
  const force = req.query.force === "1";
  const quiet = req.query.quiet !== "0";
  const now = Date.now();

  if (!force && statusSnapshot.body && now - statusSnapshot.at < STATUS_CACHE_MS) {
    res.json(statusSnapshot.body);
    return;
  }

  const config = await getConfig();
  const statuses = await collectProviderStatuses(config, { quiet });
  const body = { statuses, checkedAt: new Date().toISOString() };
  statusSnapshot = { at: now, body };
  res.json(body);
});

app.get("/api/routing/registry", async (req, res) => {
  const config = await getConfig();
  const rawRegistry = buildModelRegistry(config, getStatuses(), catalogStore.get());
  const benchmarks = await getBenchmarkData(config.integrations?.openrouterApiKey, { force: req.query.refreshBenchmarks === "1" });
  // P0-7: stale benchmark data must not influence scoring. Withheld from
  // annotation entirely so the panel's ranking stays identical to the live
  // routing decision; staleness is reported in the `benchmarks` block below
  // so the dashboard can say why scoring went internal-only.
  const applyBenchmarks = benchmarks.enabled && !benchmarks.stale;
  const registry = applyBenchmarks
    ? annotateRegistryWithBenchmarks(rawRegistry, benchmarks.rows, { fetchedAt: benchmarks.lastSuccessfulFetchAt })
    : rawRegistry;
  res.json({
    registry,
    taskRanking: rankRegistryByTask(registry, config.routing?.taskRoutes),
    taskTypes: TASK_TYPES,
    methodology: scoringMethodology(),
    benchmarks: {
      enabled: benchmarks.enabled,
      applied: applyBenchmarks,
      error: benchmarks.error,
      cachedAt: benchmarks.cachedAt,
      lastAttemptAt: benchmarks.lastAttemptAt,
      lastSuccessfulFetchAt: benchmarks.lastSuccessfulFetchAt,
      dataAgeMs: benchmarks.dataAgeMs,
      maxUsableAgeMs: benchmarks.maxUsableAgeMs,
      stale: benchmarks.stale,
      sourceMeta: benchmarks.meta,
      matchedCount: registry.filter((e) => e.externalBenchmark).length
    },
    builtAt: new Date().toISOString()
  });
});


/**
 * PARAGON-D-004D1 (Phase 1): the read-only provider routing summary that
 * replaced the provider card's `Model` dropdown. Counts and observed usage,
 * never a stored selection.
 */
app.get("/api/routing/providers", async (_req, res) => {
  const config = await getConfig();
  res.json({
    providers: buildProviderRoutingSummaries(config, getStatuses(), catalogStore.get(), routeActivity),
    selection: "automatic-per-request",
    builtAt: new Date().toISOString()
  });
});

/**
 * PARAGON-D-004D1 (Phases 2, 3, 5, 7): what actually decides a live route,
 * what shadow would decide, the latest attempt plan from each engine, and the
 * deprecated compatibility fields — in one payload, so the dashboard cannot
 * describe one engine using the other's wording.
 */
app.get("/api/routing/status", async (_req, res) => {
  const config = await getConfig();
  const settings = config.routingIntelligence ?? {};
  const plans = routeActivity.plans();
  res.json({
    liveRouter: {
      engine: "paragon-d-004c1",
      mode: "live",
      selectionMethod: "deterministic-score",
      decidesExecution: true,
      catalogEligibilityEnforced: true,
      staticDefaultFallback: false,
      taskProviderPreferenceActive: true,
      taskProviderPreferencePoints: scoringMethodology().weights.taskRoutePreference,
      emptyEligibleSetBehavior: { status: 503, code: "no_eligible_model" },
      maxAttempts: config.orchestration?.fallback?.maxAttempts ?? null,
      latestAttemptPlan: plans.live
    },
    shadowRouter: {
      engine: "paragon-d-004d",
      mode: settings.mode ?? "shadow",
      enabled: settings.enabled !== false,
      selectionMethod: "expected-utility",
      maximumAttempts: settings.maximumAttempts ?? 4,
      decidesExecution: false,
      affectsProviderExecution: false,
      additionalProviderCalls: false,
      // Explicitly stated so the dashboard never has to infer it: taskRoutes
      // is a D-004C1 input and is not consumed as an operator-policy input by
      // the shadow expected-utility scorer's preference term.
      consumesTaskProviderPreference: false,
      summary: routingIntelligence.shadowStore.summary(),
      latest: routingIntelligence.shadowStore.list({ limit: 1 })[0] ?? null,
      latestAttemptPlan: plans.shadow,
      telemetryEntryCount: Object.keys(routingIntelligence.getTelemetry().entries ?? {}).length
    },
    deprecatedConfigFields: DEPRECATED_CONFIG_FIELDS,
    activePreferenceFields: ACTIVE_BUT_MISREPRESENTED_FIELDS,
    builtAt: new Date().toISOString()
  });
});

/**
 * PARAGON-D-004D1: avatar upload for any provider, including operator-added
 * ones. Writes the file and returns the served path; the dashboard then stores
 * that path in `providers.<id>.avatar` through the normal config save, so the
 * config never carries base64 image data.
 */
app.post("/api/providers/:provider/avatar", async (req, res) => {
  const config = await getConfig();
  const provider = req.params.provider;
  if (!config.providers[provider]) {
    res.status(404).json({ error: { message: "Unknown provider" } });
    return;
  }
  const result = await saveProviderAvatar(provider, req.body?.dataUrl);
  if (result.error) {
    res.status(400).json({ error: { message: result.error, type: "paragon_avatar_error" } });
    return;
  }
  cachedConfig = await writeConfig({
    ...config,
    providers: { ...config.providers, [provider]: { ...config.providers[provider], avatar: result.avatar } }
  });
  res.json({ provider, avatar: result.avatar, bytes: result.bytes });
});

app.delete("/api/providers/:provider/avatar", async (req, res) => {
  const config = await getConfig();
  const provider = req.params.provider;
  if (!config.providers[provider]) {
    res.status(404).json({ error: { message: "Unknown provider" } });
    return;
  }
  const result = await removeProviderAvatar(provider);
  if (result.error) {
    res.status(400).json({ error: { message: result.error } });
    return;
  }
  cachedConfig = await writeConfig({
    ...config,
    providers: { ...config.providers, [provider]: { ...config.providers[provider], avatar: "" } }
  });
  res.json({ provider, avatar: "" });
});

app.get("/api/auth/flows", (_req, res) => {
  res.json({ flows: AUTH_FLOWS });
});

app.get("/api/auth/:provider/state", (req, res) => {
  res.json(getAuthState(req.params.provider));
});

app.get("/api/auth/:provider/session", async (req, res) => {
  const session = getAuthSession(req.params.provider);
  if (!session?.url && !session?.deviceCode) {
    res.status(404).json({ error: "No pending login session" });
    return;
  }
  res.json(session);
});

app.post("/api/auth/:provider/start", async (req, res) => {
  const config = await getConfig();
  const providerConfig = config.providers[req.params.provider];
  if (!providerConfig) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  try {
    const result = await startAuth(req.params.provider, providerConfig, {
      force: Boolean(req.body?.force)
    });
    invalidateStatusCache();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

app.post("/api/auth/:provider/code", async (req, res) => {
  try {
    res.json(submitAuthCode(req.params.provider, req.body?.code));
    invalidateStatusCache();
  } catch (error) {
    res.status(400).json({
      error: { message: error.message, type: "paragon_auth_code_error" }
    });
  }
});

app.post("/api/providers/:provider/models", async (req, res) => {
  const config = await getConfig();
  const provider = req.params.provider;
  const providerConfig = config.providers[provider];
  if (!providerConfig) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }

  try {
    const models = await listModels(provider, providerConfig);
    cachedConfig = await writeConfig({
      ...config,
      providers: {
        ...config.providers,
        [provider]: {
          ...providerConfig,
          models
        }
      }
    });
    res.json({ provider, models });
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message,
        type: "paragon_model_list_error",
        provider
      }
    });
  }
});

let catalogRefreshInFlight = null;

app.get("/api/model-catalog", async (_req, res) => {
  res.json(catalogStore.get());
});

app.post("/api/model-catalog/refresh", async (_req, res) => {
  if (catalogRefreshInFlight) {
    res.status(409).json({ error: { message: "A catalog refresh is already in progress" } });
    return;
  }
  const config = await getConfig();
  catalogRefreshInFlight = modelCatalogScheduler.triggerNow().finally(() => {
    catalogRefreshInFlight = null;
  });
  try {
    const result = await catalogRefreshInFlight;
    if (result.skipped) {
      res.status(409).json({ error: { message: result.reason } });
      return;
    }
    cachedCatalog = result.catalog;
    const cleared = await reconcileConfigWithCatalog("manual catalog refresh");
    res.json({ ok: true, outcomes: result.outcomes, clearedConfiguredModels: cleared, catalog: cachedCatalog });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

app.post("/api/model-catalog/providers/:provider/refresh", async (req, res) => {
  const config = await getConfig();
  const provider = req.params.provider;
  const providerConfig = config.providers[provider];
  if (!providerConfig) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  try {
    const settings = config.modelCatalog ?? {};
    const result = await refreshProviderCatalog(provider, providerConfig, cachedCatalog, {
      maxValidationProbesPerProvider: settings.maxValidationProbesPerProvider ?? 10
    });
    await saveCatalog(cachedCatalog);
    const cleared = await reconcileConfigWithCatalog(`manual ${provider} catalog refresh`);
    res.json({ provider, ...result, clearedConfiguredModels: cleared, catalog: cachedCatalog.providers[provider] });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, provider } });
  }
});

app.post("/api/model-catalog/providers/:provider/models/:model/validate", async (req, res) => {
  const config = await getConfig();
  const provider = req.params.provider;
  const modelId = req.params.model;
  const providerConfig = config.providers[provider];
  if (!providerConfig) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  const result = await defaultProbe(provider, providerConfig, modelId, {});
  await catalogStore.recordResult(provider, modelId, result);
  const cleared = await reconcileConfigWithCatalog(`validation of ${provider}/${modelId}`);
  res.json({
    provider,
    model: modelId,
    state: cachedCatalog.providers[provider]?.models[modelId]?.state,
    classification: result.classification,
    clearedConfiguredModels: cleared
  });
});

let validateAllInFlight = null;

/**
 * Walks every non-alias, non-retired model currently in the catalog across
 * every enabled provider and probes each one individually with a minimal,
 * cheap request (max_tokens: 1 where the provider honors it — see
 * defaultProbe's doc comment for the CLI-provider caveat). Sequential and
 * synchronous per model, but each await yields the event loop, so this
 * never blocks other requests — and a failure on one model is recorded and
 * skipped, never aborting the run: "don't block, just leave it
 * unvalidated" is the whole point of this endpoint.
 */
app.post("/api/model-catalog/validate-all", async (req, res) => {
  if (validateAllInFlight) {
    res.status(409).json({ error: { message: "A validate-all run is already in progress" } });
    return;
  }

  const config = await getConfig();
  const targets = [];
  for (const [provider, bucket] of Object.entries(cachedCatalog.providers ?? {})) {
    const providerConfig = config.providers[provider];
    if (!providerConfig?.enabled) {
      continue;
    }
    for (const model of Object.values(bucket.models ?? {})) {
      if (model.isAlias || model.state === "retired") {
        continue;
      }
      targets.push({ provider, providerConfig, modelId: model.modelId });
    }
  }

  const run = (async () => {
    const results = { total: targets.length, validated: 0, stillUnvalidated: 0, results: [] };
    for (const { provider, providerConfig, modelId } of targets) {
      const outcome = await defaultProbe(provider, providerConfig, modelId, { timeoutMs: 30000 });
      await catalogStore.recordResult(provider, modelId, outcome);
      if (outcome.success) {
        results.validated += 1;
      } else {
        results.stillUnvalidated += 1;
      }
      results.results.push({
        provider,
        model: modelId,
        success: outcome.success,
        classification: outcome.classification,
        state: cachedCatalog.providers[provider]?.models[modelId]?.state
      });
    }
    return results;
  })();

  validateAllInFlight = run.finally(() => {
    validateAllInFlight = null;
  });

  try {
    const summary = await validateAllInFlight;
    res.json({ ok: true, ...summary, catalog: cachedCatalog });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

/**
 * PARAGON-D-004D routing-intelligence API (Phases 11 and 12).
 *
 * `/scenario` is the dashboard's ranking source and calls the *same*
 * computeShadowRoute() the live shadow pass uses, with the same settings —
 * so for an identical task profile the dashboard and shadow rankings are
 * identical by construction, not by convention (directive test 23).
 */
app.get("/api/routing-intelligence", async (_req, res) => {
  const config = await getConfig();
  const settings = config.routingIntelligence ?? {};
  res.json({
    settings: {
      enabled: settings.enabled !== false,
      mode: settings.mode ?? "shadow",
      unknownLargeContextThresholdTokens: settings.unknownLargeContextThresholdTokens ?? 50000,
      minimumSamplesForMeasuredEstimate: settings.minimumSamplesForMeasuredEstimate ?? 10,
      maximumAttempts: settings.maximumAttempts ?? 4,
      telemetryRetentionDays: settings.telemetryRetentionDays ?? 30
    },
    // The live selector remains D-004C1 for the whole of this directive.
    liveRouteSelector: "paragon-d-004c1",
    shadowSummary: routingIntelligence.shadowStore.summary(),
    telemetryEntryCount: Object.keys(routingIntelligence.getTelemetry().entries ?? {}).length,
    providerGrammars: providerGrammarSummary()
  });
});

/**
 * PARAGON-D-004D1 (Phase 6): the D-004D shadow settings that genuinely change
 * the shadow computation. Only these scalars are writable — the operator-
 * reviewed mapping tables (canonical aliases, reasoning profiles, capability
 * overrides, context overrides) are displayed read-only, because a malformed
 * hand-typed mapping would silently change how every candidate is profiled.
 *
 * `mode` is deliberately NOT writable here. Promoting D-004D from shadow to
 * live is an activation decision gated behind its own directive; a dashboard
 * field would make it a stray click.
 */
const SHADOW_SETTING_BOUNDS = {
  unknownLargeContextThresholdTokens: { min: 1000, max: 2_000_000, integer: true },
  minimumSamplesForMeasuredEstimate: { min: 1, max: 1000, integer: true },
  maximumAttempts: { min: 1, max: 12, integer: true },
  telemetryRetentionDays: { min: 1, max: 365, integer: true },
  quotaScarcity: { min: 0, max: 1, integer: false }
};

app.put("/api/routing-intelligence/settings", async (req, res) => {
  const config = await getConfig();
  const incoming = req.body ?? {};
  const errors = [];
  const next = { ...(config.routingIntelligence ?? {}) };

  if (incoming.mode !== undefined && incoming.mode !== (config.routingIntelligence?.mode ?? "shadow")) {
    errors.push("mode is not settable from the dashboard — live activation of D-004D requires its own directive");
  }
  if (incoming.enabled !== undefined) {
    if (typeof incoming.enabled !== "boolean") {
      errors.push("enabled must be a boolean");
    } else {
      next.enabled = incoming.enabled;
    }
  }
  for (const [key, bounds] of Object.entries(SHADOW_SETTING_BOUNDS)) {
    if (incoming[key] === undefined) {
      continue;
    }
    const value = Number(incoming[key]);
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max || (bounds.integer && !Number.isInteger(value))) {
      errors.push(`${key} must be ${bounds.integer ? "an integer" : "a number"} between ${bounds.min} and ${bounds.max}`);
      continue;
    }
    next[key] = value;
  }

  if (errors.length) {
    res.status(400).json({ error: { message: "Invalid shadow settings", type: "paragon_routing_intelligence_error", details: errors } });
    return;
  }

  cachedConfig = await writeConfig({ ...config, routingIntelligence: next });
  res.json(cachedConfig.routingIntelligence);
});

app.get("/api/routing-intelligence/shadow-records", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ records: routingIntelligence.shadowStore.list({ limit }), summary: routingIntelligence.shadowStore.summary() });
});

app.post("/api/routing-intelligence/scenario", async (req, res) => {
  const config = await getConfig();
  const settings = config.routingIntelligence ?? {};
  try {
    const scenario = req.body ?? {};
    // A scenario may either supply an explicit profile or a prompt to derive
    // one from, so the dashboard can reproduce a real recorded request.
    const taskProfile = scenario.taskProfile
      ? scenario.taskProfile
      : buildTaskProfile({
          prompt: String(scenario.prompt ?? ""),
          body: {
            stream: Boolean(scenario.streaming),
            tools: scenario.toolCalls ? [{ type: "function", function: { name: "scenario" } }] : undefined,
            response_format: scenario.structuredOutput ? { type: scenario.jsonSchema ? "json_schema" : "json_object" } : undefined,
            max_tokens: Number.isFinite(scenario.maxOutputTokens) ? scenario.maxOutputTokens : undefined
          },
          estimatedInputTokens: Number.isFinite(scenario.estimatedInputTokens) ? scenario.estimatedInputTokens : 0,
          hints: { maxCostClass: scenario.maxCostClass ?? null },
          options: { largeThreshold: settings.unknownLargeContextThresholdTokens ?? 50000 }
        });

    // Explicit scenario overrides on top of the derived profile.
    for (const field of ["reasoningDemand", "latencyPreference", "costSensitivity", "qualityPreference", "complexity", "risk", "workType"]) {
      if (scenario[field]) taskProfile[field] = scenario[field];
    }

    const shadow = computeShadowRoute({
      config,
      statuses: getStatuses(),
      catalog: catalogStore.get(),
      telemetryStore: routingIntelligence.getTelemetry(),
      benchmarkRows: await benchmarkRowsForScoring(config),
      taskProfile,
      hints: { maxCostClass: scenario.maxCostClass ?? null },
      settings
    });

    res.json({ taskProfile, ...shadow, liveRouteSelector: "paragon-d-004c1", computedAt: new Date().toISOString() });
  } catch (error) {
    res.status(400).json({ error: { message: error.message, type: "paragon_routing_intelligence_error" } });
  }
});

/** Shared helper so scenario scoring uses the same stale-withholding rule as live scoring (D-004C1 P0-7). */
async function benchmarkRowsForScoring(config) {
  const benchmarks = await getBenchmarkData(config.integrations?.openrouterApiKey);
  return benchmarks.enabled && !benchmarks.stale ? benchmarks.rows : [];
}

app.get("/api/logs", (_req, res) => {
  res.json({ logs: getLogs() });
});

app.get("/api/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  for (const entry of getLogs().slice().reverse()) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  const unsubscribe = subscribeLogs((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });
  req.on("close", unsubscribe);
});

registerOpenAiRoutes(app, getConfig, orchestration, getStatuses, catalogStore, routingIntelligence);
// Mounted after `app.use("/api", adminAuth)` above, so these inherit admin auth.
registerOrchestrationRoutes(app, orchestration, getConfig, async (next) => {
  cachedConfig = await writeConfig(next);
  return cachedConfig;
});

const host = getEnv("HOST") ?? cachedConfig.server.host;
const port = Number(getEnv("PORT") ?? cachedConfig.server.port);

app.listen(port, host, () => {
  console.log(`PARAGON dashboard:   http://${host}:${port}`);
  console.log(`Cursor model:        ${cachedConfig.server.exposedModel}`);
  console.log(`API key:             ${cachedConfig.server.apiKey ? "(configured)" : "(missing — set PARAGON_API_KEY)"}`);
  const ts = tailscaleUrls(cachedConfig.server);
  if (ts) {
    console.log(`Tailnet dashboard:   ${ts.tailnetDashboard}`);
    console.log(`PARAGON base URL:    ${ts.cursorBaseUrl}`);
    console.log(`Run: ./scripts/tailscale-setup.sh (once) to bind Tailscale ports`);
  } else {
    console.log(`PARAGON base URL:    http://${host}:${port}/v1`);
    console.log(`Set server.tailscaleHost in config for Tailscale URLs`);
  }
});
