import cors from "cors";
import express from "express";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AUTH_FLOWS } from "./authFlows.js";
import { createAuthMiddleware } from "./auth.js";
import { dataDir, readConfig, writeConfig } from "./configStore.js";
import { getEnv } from "./env.js";
import { getLogs, subscribeLogs, addLog, clearLogs } from "./logStore.js";
import { registerOpenAiRoutes } from "./openaiApi.js";
import { getAuthSession, getAuthState, listModels, runStatus, startAuth, submitAuthCode } from "./cli.js";
import { tailscaleUrls } from "./tailscaleUrls.js";
import { createOrchestrationRuntime } from "./orchestration/telemetry.js";
import { registerOrchestrationRoutes } from "./orchestration/api.js";
import { buildModelRegistry } from "./routing/modelRegistry.js";
import { classifyChatCapability } from "./modelCapability.js";
import { getBenchmarkData, annotateRegistryWithBenchmarks } from "./routing/benchmarks.js";
import { applyExecutionResult, listCatalogEntries, loadCatalog, saveCatalog } from "./modelCatalog.js";
import { defaultProbe, refreshProviderCatalog } from "./modelCatalogRefresh.js";
import { startModelCatalogScheduler } from "./modelCatalogScheduler.js";
import { loadTelemetry, saveTelemetry, recordOutcome as recordTelemetryOutcome, pruneTelemetry } from "./routing/outcomeTelemetry.js";
import { selectAutomaticRoute } from "./routing/automaticRouting.js";
import { buildTaskProfile } from "./routing/taskProfile.js";
import { providerGrammarSummary } from "./routing/executionProfile.js";
import { createRouteActivityStore } from "./routing/routeActivity.js";
import { createQuotaStateStore } from "./routing/quotaState.js";
import { buildProviderRoutingSummaries } from "./routing/providerSummary.js";
import {
  normalizeRoutingPriority,
  routingPriorityDescription,
  routingPriorityOptions
} from "./routing/routingPriority.js";
import { circuitStateSnapshot } from "./orchestration/liveEnforcement.js";
import { AVATAR_DIR, AVATAR_ROUTE, removeProviderAvatar, saveProviderAvatar } from "./providerAvatars.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedConfig = await readConfig();
let cachedCatalog = await loadCatalog();

/**
 * Single in-process view of the persisted model catalog. recordResult() is the
 * immediate-exclusion feedback path — a request that fails with a
 * model-specific classification updates the shared in-memory catalog (and
 * persists it) before the *next* request is routed, without waiting for the
 * next scheduled refresh.
 */
const catalogStore = {
  get: () => cachedCatalog,
  async recordResult(provider, modelId, resultInfo) {
    applyExecutionResult(cachedCatalog, provider, modelId, resultInfo);
    await saveCatalog(cachedCatalog);
    return cachedCatalog;
  }
};

let cachedTelemetry = await loadTelemetry();
{
  const settings = cachedConfig.automaticRouting ?? {};
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

const routeActivity = createRouteActivityStore();

/**
 * Quota state persists across restarts. An allowance that resets on the 12th is
 * still spent after a restart, so forgetting it would cost one guaranteed
 * failed attempt (and its latency) on the next request. Every record carries
 * its own expiry, so a window that closed while PARAGON was stopped is dropped
 * on load rather than replayed.
 */
const quotaStatePath = path.join(dataDir, "quota-state.json");
let restoredQuotaState = {};
try {
  restoredQuotaState = JSON.parse(await fsp.readFile(quotaStatePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    console.warn(`quota state: could not read store, starting fresh: ${error.message}`);
  }
}
const quotaState = createQuotaStateStore({
  initial: restoredQuotaState,
  onChange: (snapshot) => {
    // Best-effort and atomic: losing this file costs one re-probe, never a
    // wrong routing decision.
    fsp
      .mkdir(dataDir, { recursive: true })
      .then(() => fsp.writeFile(`${quotaStatePath}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"))
      .then(() => fsp.rename(`${quotaStatePath}.tmp`, quotaStatePath))
      .catch((error) => console.warn(`quota state: flush failed (non-fatal): ${error.message}`));
  }
});

/**
 * The routing runtime. One engine, always live. There is no mode, no second
 * ranking, and nothing here that can be switched to a different selector.
 */
const routing = {
  get settings() {
    return cachedConfig.automaticRouting ?? {};
  },
  routeActivity,
  quotaState,
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
  }
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
// Operator-uploaded provider avatars. Bundled avatars ship under
// public/avatars/; these are the per-deployment overrides.
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
 * /api/status — the router needs a health signal per request but must never
 * trigger a fresh CLI spawn per chat completion. Returns {} (all providers
 * "unknown" health) until the cache has been warmed once.
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

  // A newly enabled provider is `pending_assessment` and contributes nothing
  // routable until real discovery succeeds — so kick off a bounded refresh for
  // it immediately rather than leaving it dark until the next 24h cycle.
  // Fire-and-forget: the operator's config write has already been
  // acknowledged, and a discovery failure correctly leaves the provider
  // unavailable rather than trusted.
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

/**
 * The one settings write (Phase 7). Bounded and explicitly enumerated: a
 * category the caller did not send is left exactly as it was, so saving
 * General can never clear Routing, and neither can touch credentials,
 * provider enablement, avatars, or catalog state.
 */
app.put("/api/settings", async (req, res) => {
  const config = await getConfig();
  const incoming = req.body ?? {};
  const errors = [];

  const server = { ...config.server };
  const routingSection = { ...config.routing };
  const integrations = { ...config.integrations };
  const automaticRouting = { ...config.automaticRouting };

  if (incoming.server && typeof incoming.server === "object") {
    for (const field of ["exposedModel", "apiKey", "tailscaleHost", "cursorBaseUrl"]) {
      if (incoming.server[field] !== undefined) {
        if (typeof incoming.server[field] !== "string") {
          errors.push(`server.${field} must be a string`);
          continue;
        }
        server[field] = incoming.server[field].trim();
      }
    }
    for (const field of ["tailscaleServePort", "tailscaleFunnelPort"]) {
      if (incoming.server[field] !== undefined) {
        const value = Number(incoming.server[field]);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          errors.push(`server.${field} must be a port between 1 and 65535`);
          continue;
        }
        server[field] = value;
      }
    }
    if (incoming.server.exposedModel !== undefined && !server.exposedModel) {
      errors.push("server.exposedModel cannot be empty");
    }
  }

  if (incoming.routing && typeof incoming.routing === "object") {
    if (incoming.routing.priority !== undefined) {
      const requested = String(incoming.routing.priority);
      if (normalizeRoutingPriority(requested) !== requested) {
        errors.push("routing.priority must be one of balanced, quality, cost, speed");
      } else {
        routingSection.priority = requested;
      }
    }
  }

  if (incoming.integrations && typeof incoming.integrations === "object") {
    if (incoming.integrations.openrouterApiKey !== undefined) {
      integrations.openrouterApiKey = String(incoming.integrations.openrouterApiKey).trim();
    }
  }

  if (incoming.data && typeof incoming.data === "object") {
    if (incoming.data.activityRetentionDays !== undefined) {
      const value = Number(incoming.data.activityRetentionDays);
      if (!Number.isInteger(value) || value < 1 || value > 365) {
        errors.push("data.activityRetentionDays must be an integer between 1 and 365");
      } else {
        automaticRouting.telemetryRetentionDays = value;
      }
    }
  }

  if (errors.length) {
    res.status(400).json({ error: { message: "Invalid settings", type: "paragon_settings_error", details: errors } });
    return;
  }

  cachedConfig = await writeConfig({ ...config, server, routing: routingSection, integrations, automaticRouting });
  res.json({ ok: true, settings: productSettings(cachedConfig) });
});

/** The bounded, product-facing view of settings — never the whole config object. */
function productSettings(config) {
  return {
    server: {
      exposedModel: config.server.exposedModel,
      apiKeyConfigured: Boolean(config.server.apiKey),
      tailscaleHost: config.server.tailscaleHost,
      tailscaleServePort: config.server.tailscaleServePort,
      tailscaleFunnelPort: config.server.tailscaleFunnelPort,
      cursorBaseUrl: config.server.cursorBaseUrl
    },
    routing: {
      priority: normalizeRoutingPriority(config.routing?.priority),
      options: routingPriorityOptions()
    },
    integrations: { openrouterApiKeyConfigured: Boolean(config.integrations?.openrouterApiKey) },
    data: { activityRetentionDays: config.automaticRouting?.telemetryRetentionDays ?? 30 }
  };
}

app.get("/api/settings", async (_req, res) => {
  res.json(productSettings(await getConfig()));
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

/** Connection block for the everyday dashboard (Phase 6.1). */
function connectionInfo(config) {
  const ts = tailscaleUrls(config.server);
  return {
    baseUrl: config.server.cursorBaseUrl || ts?.cursorBaseUrl || `http://${config.server.host}:${config.server.port}/v1`,
    exposedModel: config.server.exposedModel,
    apiKeyConfigured: Boolean(config.server.apiKey),
    apiKey: config.server.apiKey || "",
    tailnetDashboard: ts?.tailnetDashboard ?? null
  };
}

/**
 * Overall service health, expressed the way the product talks about it rather
 * than as an internal state machine.
 */
function serviceHealth(providers) {
  const enabled = providers.filter((p) => p.enabled);
  if (!enabled.length) {
    return { state: "setup_required", summary: "No providers are connected yet" };
  }
  const ready = enabled.filter((p) => p.status === "ready");
  if (!ready.length) {
    return { state: "needs_attention", summary: "No provider is currently able to serve requests" };
  }
  if (ready.length < enabled.length) {
    return { state: "degraded", summary: `${ready.length} of ${enabled.length} providers ready` };
  }
  return { state: "ready", summary: `${ready.length} provider${ready.length === 1 ? "" : "s"} ready` };
}

/**
 * Provider cards (Phase 6.2). Product vocabulary only: a card says Ready or
 * Needs attention and why, and reports the model that actually ran last. It
 * never shows a model selector — the model is chosen per request — and it
 * only surfaces internal catalog counts when something is wrong.
 */
function providerCards(config, summaries) {
  return summaries.map((summary) => {
    const providerConfig = config.providers?.[summary.provider] ?? {};
    let status = "ready";
    let attention = null;

    if (!summary.enabled) {
      status = "disabled";
    } else if (summary.usageLimit) {
      status = "usage_limited";
      attention = summary.usageLimit.resetAt
        ? `Usage limit reached — available again ${new Date(summary.usageLimit.resetAt).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          })}`
        : "Usage limit reached";
    } else if (summary.pendingAssessment) {
      status = "needs_attention";
      attention = "Model discovery has not completed yet";
    } else if (summary.health === "unhealthy") {
      status = "needs_attention";
      attention = "Sign-in required or provider unreachable";
    } else if (!summary.counts.eligible) {
      status = "needs_attention";
      attention = "Model discovery failed — no models are currently available";
    }

    return {
      provider: summary.provider,
      label: summary.label,
      avatar: providerConfig.avatar ?? "",
      icon: providerConfig.icon ?? "",
      type: summary.type,
      enabled: summary.enabled,
      status,
      attention,
      modelsAvailable: summary.counts.eligible,
      lastUsed: summary.lastExecutedModel,
      lastFailure: summary.lastFailure,
      usageLimit: summary.usageLimit,
      // Only meaningful for an HTTP provider; the UI shows these behind Edit.
      baseUrl: providerConfig.baseUrl ?? "",
      apiKeyConfigured: Boolean(providerConfig.apiKey),
      command: providerConfig.command ?? "",
      // Engineering detail, shown on the card only when the provider has a
      // problem the operator has to act on.
      diagnostics: status === "ready" || status === "disabled" ? null : { counts: summary.counts, catalogState: summary.catalogState }
    };
  });
}

/** The Automatic Routing card (Phase 6.3) — compact, product language only. */
function automaticRoutingCard(config, cards) {
  const priority = normalizeRoutingPriority(config.routing?.priority);
  const available = cards.filter((c) => c.enabled && c.status === "ready");
  const warnings = [];
  for (const card of cards) {
    if (card.status === "usage_limited") {
      warnings.push(`${card.label} reached its usage limit`);
    } else if (card.status === "needs_attention") {
      warnings.push(`${card.label} needs attention`);
    }
  }
  const latest = routeActivity.latestSuccess();
  const recovery = routeActivity.latestRecovery();
  return {
    active: available.length > 0,
    priority,
    priorityLabel: routingPriorityOptions().find((o) => o.value === priority)?.label ?? priority,
    availableProviders: available.map((c) => ({ provider: c.provider, label: c.label })),
    latestRoute: latest
      ? { at: latest.at, provider: latest.provider, model: latest.model, durationMs: latest.durationMs }
      : null,
    latestRecovery: recovery
      ? {
          at: recovery.at,
          provider: recovery.provider,
          model: recovery.model,
          recoveredFrom: recovery.recoveredFrom,
          reason: recovery.recoveredFromReason
        }
      : null,
    warnings
  };
}

/**
 * One payload for the everyday dashboard: Connection, Providers, Automatic
 * Routing, Recent Activity. Nothing else — no attempt plans, no catalog
 * tables, no engine identity, no routing internals.
 */
app.get("/api/overview", async (_req, res) => {
  const config = await getConfig();
  const summaries = buildProviderRoutingSummaries(config, getStatuses(), catalogStore.get(), routeActivity, { quotaState });
  const cards = providerCards(config, summaries);
  const anyAssessed = summaries.some((s) => s.enabled && !s.pendingAssessment && s.counts.eligible > 0);

  res.json({
    connection: connectionInfo(config),
    health: serviceHealth(cards),
    providers: cards,
    routing: automaticRoutingCard(config, cards),
    activity: routeActivity.recent({ limit: 20 }),
    // Drives the first-run flow (Phase 10) rather than a separate probe.
    onboarding: { required: !anyAssessed, hasProviders: cards.some((c) => c.enabled) },
    builtAt: new Date().toISOString()
  });
});

/**
 * The combined Model Ranking (one table, not two).
 *
 * Merges what used to be the separate "Model Catalog" and "Model Routing"
 * panels: every model PARAGON has access to, its catalog/validation status,
 * and — for the ones that are actually routable — the live ranking with the
 * factors that produced it (reasoning effort, quality and its evidence, cost
 * and its evidence, latency, uncertainty, context, benchmark attribution).
 *
 * The ranking is the *real* one: it calls the same selectAutomaticRoute() the
 * request path calls, with the configured routing priority, so what this table
 * shows is what would actually happen. A model that cannot route is listed with
 * the specific gate that excluded it rather than being hidden or given a
 * meaningless score.
 *
 * Because ranking is per-request, the profile used here is stated explicitly in
 * the response and can be varied by the caller — a rank is only meaningful
 * relative to a kind of work.
 */
/**
 * The shape every Model Ranking row carries, so a consumer never has to know
 * which branch produced it.
 */
function emptyRankingRow() {
  return {
    provider: null,
    providerLabel: null,
    providerEnabled: false,
    model: null,
    displayName: null,
    canonicalModel: null,
    state: "unknown",
    validated: false,
    catalogEligible: false,
    isAlias: false,
    discoverySource: null,
    validatedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureClassification: null,
    routable: false,
    rank: null,
    of: null,
    attemptOrder: null,
    excludedBecause: null,
    excludedDetail: null,
    availableAgainAt: null,
    reasoningEffort: null,
    speedMode: null,
    executionProfile: null,
    reasoningFit: null,
    reasoningFitReason: null,
    expectedUtility: null,
    providerPreferenceBonus: 0,
    quality: null,
    successProbability: null,
    latency: null,
    uncertainty: null,
    cost: null,
    contextWindow: null,
    contextConfidence: null,
    capabilities: null,
    benchmark: null,
    telemetry: null,
    measuredEvidenceShare: null,
    lastExecuted: null
  };
}

app.get("/api/models/ranking", async (req, res) => {
  const config = await getConfig();
  const catalog = catalogStore.get();
  const ttlHours = config.modelCatalog?.validationTtlHours ?? 24;

  const taskProfile = buildTaskProfile({
    prompt: String(req.query.prompt ?? "implement a function"),
    body: {},
    estimatedInputTokens: Number.isFinite(Number(req.query.tokens)) ? Number(req.query.tokens) : 4000,
    options: { largeThreshold: routing.settings.unknownLargeContextThresholdTokens ?? 50000 }
  });
  for (const field of ["workType", "complexity", "reasoningDemand", "latencyPreference", "costSensitivity", "qualityPreference"]) {
    if (req.query[field]) taskProfile[field] = String(req.query[field]);
  }

  const benchmarks = await getBenchmarkData(config.integrations?.openrouterApiKey);
  const route = selectAutomaticRoute({
    config,
    statuses: getStatuses(),
    catalog,
    telemetryStore: routing.getTelemetry(),
    benchmarkRows: benchmarks.enabled && !benchmarks.stale ? benchmarks.rows : [],
    taskProfile,
    settings: routing.settings,
    quotaState,
    priority: req.query.priority ?? config.routing?.priority
  });

  const rankedByKey = new Map();
  for (const candidate of route.ranked ?? []) {
    rankedByKey.set(`${candidate.provider}/${candidate.providerModelId}`, candidate);
  }
  const plannedOrder = new Map((route.attemptPlan ?? []).map((a, index) => [`${a.name}/${a.registryModel}`, index + 1]));

  const rows = [];
  for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
    const assessed = Boolean(catalog?.providers && Object.prototype.hasOwnProperty.call(catalog.providers, provider));
    if (!assessed) {
      // Same shape as every other row. A row that omits keys the rest carry
      // forces every consumer to special-case it, and a table that renders
      // `undefined` for a provider is worse than one that renders "unknown".
      rows.push({
        ...emptyRankingRow(),
        provider,
        providerLabel: providerConfig.label || provider,
        providerEnabled: Boolean(providerConfig.enabled),
        state: "pending_assessment",
        excludedBecause: "routing.providerPendingAssessment",
        excludedDetail: "model discovery has not completed for this provider"
      });
      continue;
    }

    for (const entry of listCatalogEntries(catalog, provider, { ttlHours })) {
      const candidate = rankedByKey.get(`${provider}/${entry.modelId}`);
      const components = candidate?.components ?? null;
      const cost = candidate?.cost ?? null;

      /**
       * Why this model cannot route. A candidate carries its own gate reason;
       * a model that never became a candidate was filtered earlier, and the
       * specific cause is worth naming rather than reporting a generic "not
       * eligible" for a rejected model, a non-chat model and a disabled
       * provider alike.
       */
      let excludedBecause = null;
      let excludedDetail = null;
      let availableAgainAt = null;
      if (candidate?.excluded) {
        excludedBecause = candidate.reasonCode;
        excludedDetail = candidate.detail ?? null;
        if (candidate.reasonCode === "eligibility.quotaExhausted") {
          // A usage limit is temporary, and the provider usually says when it
          // lifts. Reporting the instant turns "unavailable" into "unavailable
          // until", and lets the table re-include the model automatically once
          // the window closes.
          availableAgainAt = quotaState.state(provider)?.resetAt ?? null;
          excludedDetail = "the provider's usage limit was reached";
        }
      } else if (!candidate) {
        if (!providerConfig.enabled) {
          excludedBecause = "eligibility.providerDisabled";
          excludedDetail = "the provider is turned off";
        } else if (!entry.automaticEligibility) {
          excludedBecause = "eligibility.catalogState";
          // A usage limit is recorded in two places: per-model in the catalog
          // (`quota_blocked`) and per-provider in the quota store, which is the
          // one that knows *when it lifts*. Surface the reset on this path too,
          // otherwise the model that actually hit the limit is the one row that
          // fails to say when it comes back.
          if (entry.state === "quota_blocked") {
            availableAgainAt = quotaState.state(provider)?.resetAt ?? null;
          }
          // A `validated` entry that is nonetheless ineligible has simply aged
          // past its validation TTL — reporting "catalog state: validated" as
          // the reason it cannot route would be actively confusing.
          const expired = entry.state === "validated" || entry.state === "stale";
          excludedDetail = expired
            ? "validation has expired and needs re-checking"
            : {
                retired: "no longer offered by the provider",
                unknown: "discovered but never validated",
                rejected: "the provider rejected this model",
                unavailable: "the provider reported it unavailable",
                quota_blocked: "the provider's usage limit was reached",
                authentication_blocked: "the provider needs to be signed in again",
                entitlement_blocked: "your plan does not include this model",
                configuration_blocked: "the provider is misconfigured",
                provider_offline: "the provider was unreachable"
              }[entry.state] ?? `catalog state: ${entry.state}`;
        } else if (classifyChatCapability({ modelId: entry.modelId, metadata: entry.metadata }) === "unsupported") {
          excludedBecause = "routing.chatCapabilityUnsupported";
          excludedDetail = "not a chat model";
        } else {
          excludedBecause = "eligibility.notACandidate";
        }
      }

      rows.push({
        ...emptyRankingRow(),
        provider,
        providerLabel: providerConfig.label || provider,
        providerEnabled: Boolean(providerConfig.enabled),
        model: entry.modelId,
        displayName: entry.displayName ?? entry.modelId,
        canonicalModel: candidate?.canonicalModelId ?? null,

        // --- catalog / validation status
        state: entry.state,
        validated: entry.state === "validated",
        catalogEligible: Boolean(entry.automaticEligibility),
        isAlias: Boolean(entry.isAlias),
        discoverySource: entry.discoverySource ?? null,
        validatedAt: entry.validatedAt ?? null,
        lastSuccessAt: entry.lastSuccessAt ?? null,
        lastFailureAt: entry.lastFailureAt ?? null,
        lastFailureClassification: entry.lastFailureClassification ?? null,

        // --- routability and rank
        routable: Boolean(candidate) && !candidate.excluded,
        rank: candidate && !candidate.excluded ? candidate.rank : null,
        of: candidate && !candidate.excluded ? candidate.of : null,
        attemptOrder: plannedOrder.get(`${provider}/${entry.modelId}`) ?? null,
        excludedBecause,
        excludedDetail,
        availableAgainAt,

        // --- how it thinks
        reasoningEffort: candidate?.reasoningEffort ?? null,
        speedMode: candidate?.speedMode ?? null,
        executionProfile: candidate?.executionProfile ?? null,
        reasoningFit: components?.reasoningFitAlignment ?? null,
        reasoningFitReason: components?.reasoningFitReason ?? null,

        // --- the score and every factor behind it
        expectedUtility: candidate?.expectedUtility ?? null,
        providerPreferenceBonus: components?.providerPreferenceBonus ?? 0,
        quality: components
          ? { value: components.expectedTaskQuality, source: components.qualitySource, term: components.qualityTerm }
          : null,
        successProbability: components
          ? { value: components.probabilityOfSuccessfulCompletion, source: components.successSource }
          : null,
        latency: components
          ? { penalty: components.expectedLatencyPenalty, term: components.latencyTerm, source: components.latencySource, measuredP95Ms: components.measuredLatencyP95Ms }
          : null,
        uncertainty: components
          ? { penalty: components.uncertaintyPenalty, term: components.uncertaintyTerm, reasons: components.uncertaintyReasons }
          : null,

        // --- cost, with its evidence
        cost: cost
          ? {
              costClass: candidate.costClass,
              totalResourceCost: cost.estimatedTotalResourceCost,
              term: components?.costTerm ?? null,
              monetary: cost.estimatedMonetaryCost,
              monetaryConfidence: cost.monetaryCostConfidence,
              pricingAvailable: cost.pricingAvailable,
              unpricedMetered: cost.unpricedMeteredProvider,
              billingUnit: cost.billingUnit,
              pricingSource: cost.pricingSource,
              pricingAsOf: cost.pricingAsOf,
              quotaBurn: cost.estimatedQuotaBurn,
              quotaBurnSource: cost.quotaBurnSource,
              expectedInputTokens: cost.expectedInputTokens,
              expectedOutputTokens: cost.expectedVisibleOutputTokens,
              // When the provider does not state a reasoning effort, the cost
              // above is still charged for an assumed amount — so report that
              // amount rather than "not reported", which would leave the table
              // showing a cost for tokens it claims do not exist.
              expectedReasoningTokens: cost.expectedReasoningTokens ?? cost.conservativeReasoningFloorTokens,
              reasoningTokenRange: cost.expectedReasoningTokenRange,
              reasoningEstimateSource: cost.reasoningEstimateSource,
              reasoningAssumedConservative: cost.reasoningTokensAssumedConservative,
              uncertainty: cost.costUncertainty
            }
          : null,

        // --- context and capability evidence
        contextWindow: candidate?.contextModel?.effectiveUsableContextWindow ?? null,
        contextConfidence: candidate?.contextModel?.contextConfidence ?? null,
        capabilities: candidate?.capabilities ?? null,

        // --- external and observed evidence
        benchmark: candidate?.benchmark ?? null,
        telemetry: candidate?.telemetry ?? null,
        measuredEvidenceShare: candidate?.measuredEvidenceShare ?? null,
        lastExecuted: routeActivity.lastExecuted(provider)?.model === entry.modelId ? routeActivity.lastExecuted(provider) : null
      });
    }
  }

  // Routable models first in rank order, then everything else grouped by
  // provider so the catalog stays readable.
  rows.sort((a, b) => {
    if (a.routable !== b.routable) return a.routable ? -1 : 1;
    if (a.routable && b.routable) return (a.rank ?? 1e9) - (b.rank ?? 1e9);
    return `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`);
  });

  res.json({
    rows,
    priority: routingPriorityDescription(req.query.priority ?? config.routing?.priority),
    // A rank is only meaningful relative to a kind of work; say which.
    rankedFor: {
      workType: taskProfile.workType,
      complexity: taskProfile.complexity,
      reasoningDemand: taskProfile.reasoningDemand,
      contextBand: taskProfile.contextBand,
      estimatedInputTokens: taskProfile.estimatedInputTokens
    },
    totals: {
      models: rows.length,
      routable: rows.filter((r) => r.routable).length,
      validated: rows.filter((r) => r.validated).length,
      excluded: rows.filter((r) => !r.routable).length
    },
    benchmarks: { enabled: benchmarks.enabled, applied: benchmarks.enabled && !benchmarks.stale, stale: benchmarks.stale },
    builtAt: new Date().toISOString()
  });
});

/** Recent Activity on its own, for refresh without re-fetching everything. */
app.get("/api/activity", async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  res.json({ activity: routeActivity.recent({ limit }) });
});

app.post("/api/activity/clear", async (_req, res) => {
  routeActivity.reset();
  clearLogs();
  res.json({ ok: true });
});

// --------------------------------------------------------------------------
// Diagnostics (Phase 9). One surface, read-only except for explicit
// maintenance actions. No general-purpose save lives here.
// --------------------------------------------------------------------------

/** Diagnostics -> Models: eligible registry, catalog state, benchmark attribution. */
app.get("/api/diagnostics/models", async (req, res) => {
  const config = await getConfig();
  const rawRegistry = buildModelRegistry(config, getStatuses(), catalogStore.get());
  const benchmarks = await getBenchmarkData(config.integrations?.openrouterApiKey, { force: req.query.refreshBenchmarks === "1" });
  // Stale benchmark data must not influence scoring, so it is withheld from
  // annotation entirely; staleness is reported below so the UI can say why.
  const applyBenchmarks = benchmarks.enabled && !benchmarks.stale;
  const registry = applyBenchmarks
    ? annotateRegistryWithBenchmarks(rawRegistry, benchmarks.rows, { fetchedAt: benchmarks.lastSuccessfulFetchAt })
    : rawRegistry;
  res.json({
    registry,
    catalog: catalogStore.get(),
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
 * Diagnostics -> Routing: the live engine's own evidence. Ranked candidates,
 * utility decomposition, exclusion reasons, reasoning effort, and the resolved
 * priority weights — all read-only.
 */
app.get("/api/diagnostics/routing", async (_req, res) => {
  const config = await getConfig();
  res.json({
    engine: { selectionMethod: "expected-utility", decidesExecution: true, enginesRunningPerRequest: 1 },
    priority: routingPriorityDescription(config.routing?.priority),
    latestPlan: routeActivity.plan(),
    telemetryEntryCount: Object.keys(routing.getTelemetry().entries ?? {}).length,
    quotaState: quotaState.snapshot(),
    providerGrammars: providerGrammarSummary(),
    bounds: {
      maximumAttempts: routing.settings.maximumAttempts ?? 4,
      minimumSamplesForMeasuredEstimate: routing.settings.minimumSamplesForMeasuredEstimate ?? 10,
      unknownLargeContextThresholdTokens: routing.settings.unknownLargeContextThresholdTokens ?? 50000,
      telemetryRetentionDays: routing.settings.telemetryRetentionDays ?? 30
    },
    builtAt: new Date().toISOString()
  });
});

/**
 * Read-only routing preview. Runs the *same* selectAutomaticRoute() the live
 * request path uses, with the same settings, so for an identical profile the
 * preview and the real decision are identical by construction rather than by
 * convention. Executes nothing.
 */
app.post("/api/diagnostics/routing/preview", async (req, res) => {
  const config = await getConfig();
  try {
    const scenario = req.body ?? {};
    const taskProfile = scenario.taskProfile
      ? scenario.taskProfile
      : buildTaskProfile({
          prompt: String(scenario.prompt ?? ""),
          body: {
            stream: Boolean(scenario.streaming),
            tools: scenario.toolCalls ? [{ type: "function", function: { name: "preview" } }] : undefined,
            response_format: scenario.structuredOutput ? { type: scenario.jsonSchema ? "json_schema" : "json_object" } : undefined,
            max_tokens: Number.isFinite(scenario.maxOutputTokens) ? scenario.maxOutputTokens : undefined
          },
          estimatedInputTokens: Number.isFinite(scenario.estimatedInputTokens) ? scenario.estimatedInputTokens : 0,
          hints: { maxCostClass: scenario.maxCostClass ?? null },
          options: { largeThreshold: routing.settings.unknownLargeContextThresholdTokens ?? 50000 }
        });

    for (const field of ["reasoningDemand", "latencyPreference", "costSensitivity", "qualityPreference", "complexity", "risk", "workType"]) {
      if (scenario[field]) taskProfile[field] = scenario[field];
    }

    const benchmarks = await getBenchmarkData(config.integrations?.openrouterApiKey);
    const route = selectAutomaticRoute({
      config,
      statuses: getStatuses(),
      catalog: catalogStore.get(),
      telemetryStore: routing.getTelemetry(),
      benchmarkRows: benchmarks.enabled && !benchmarks.stale ? benchmarks.rows : [],
      taskProfile,
      hints: { maxCostClass: scenario.maxCostClass ?? null },
      settings: routing.settings,
      quotaState,
      priority: scenario.priority ?? config.routing?.priority
    });

    res.json({ taskProfile, ...route, computedAt: new Date().toISOString() });
  } catch (error) {
    res.status(400).json({ error: { message: error.message, type: "paragon_diagnostics_error" } });
  }
});

/** Diagnostics -> Requests: the raw activity log and provider errors. */
app.get("/api/diagnostics/requests", async (_req, res) => {
  res.json({
    activity: routeActivity.recent({ limit: 50 }),
    logs: getLogs(),
    telemetry: routing.getTelemetry()
  });
});

/** Diagnostics -> System: circuit states, storage, scheduler, service facts. */
app.get("/api/diagnostics/system", async (_req, res) => {
  const config = await getConfig();
  res.json({
    circuitStates: circuitStateSnapshot(),
    quotaState: quotaState.snapshot(),
    catalogSchedule: catalogStore.get().schedule,
    configVersion: config.configVersion,
    orchestration: { enabled: Boolean(config.orchestration?.enabled), mode: config.orchestration?.mode ?? "off" },
    dataDir,
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    node: process.version,
    builtAt: new Date().toISOString()
  });
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
    res.json({ ok: true, outcomes: result.outcomes, catalog: cachedCatalog });
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
    res.json({ provider, ...result, catalog: cachedCatalog.providers[provider] });
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
  res.json({
    provider,
    model: modelId,
    state: cachedCatalog.providers[provider]?.models[modelId]?.state,
    classification: result.classification
  });
});

let validateAllInFlight = null;

/**
 * Walks every non-alias, non-retired model currently in the catalog across
 * every enabled provider and probes each one individually with a minimal,
 * cheap request. Sequential per model, but each await yields the event loop,
 * so this never blocks other requests — and a failure on one model is
 * recorded and skipped, never aborting the run.
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

registerOpenAiRoutes(app, getConfig, orchestration, getStatuses, catalogStore, routing);
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
  console.log(`Routing priority:    ${normalizeRoutingPriority(cachedConfig.routing?.priority)}`);
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
