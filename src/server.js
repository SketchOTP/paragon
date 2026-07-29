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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedConfig = await readConfig();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));

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
  cachedConfig = await writeConfig(req.body);
  res.json(cachedConfig);
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
  const rawRegistry = buildModelRegistry(config, getStatuses());
  const benchmarks = await getBenchmarkData(config.integrations?.openrouterApiKey, { force: req.query.refreshBenchmarks === "1" });
  const registry = benchmarks.enabled ? annotateRegistryWithBenchmarks(rawRegistry, benchmarks.rows) : rawRegistry;
  res.json({
    registry,
    taskRanking: rankRegistryByTask(registry, config.routing?.taskRoutes),
    taskTypes: TASK_TYPES,
    methodology: scoringMethodology(),
    benchmarks: {
      enabled: benchmarks.enabled,
      error: benchmarks.error,
      cachedAt: benchmarks.cachedAt,
      sourceMeta: benchmarks.meta,
      matchedCount: registry.filter((e) => e.externalBenchmark).length
    },
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

registerOpenAiRoutes(app, getConfig, orchestration, getStatuses);
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
