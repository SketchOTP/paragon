import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_FLOWS } from "./authFlows.js";
import { createAuthMiddleware } from "./auth.js";
import { readConfig, writeConfig, syncCursorBaseUrl, getConfigPath } from "./configStore.js";

import { getLogs, subscribeLogs, addLog } from "./logStore.js";
import { registerOpenAiRoutes } from "./openaiApi.js";
import { getAuthSession, getAuthState, listModels, runStatus, startAuth, submitAntigravityAuthCode } from "./cli.js";
import {
  installCloudflared,
  startCloudflared,
  startNgrok,
  stopCloudflared,
  stopNgrok
} from "./tunnelManager.js";
import { tailscaleUrls } from "./tailscaleUrls.js";



const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedConfig = await readConfig();
let configMtimeMs = 0;

async function refreshCachedConfig(force = false) {
  try {
    const stat = await fs.stat(getConfigPath());
    if (!force && stat.mtimeMs === configMtimeMs) {
      return cachedConfig;
    }
    configMtimeMs = stat.mtimeMs;
    cachedConfig = await readConfig();
    return cachedConfig;
  } catch {
    return cachedConfig;
  }
}

try {
  configMtimeMs = (await fs.stat(getConfigPath())).mtimeMs;
} catch {
  configMtimeMs = 0;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.resolve(__dirname, "../public")));

const getConfig = async () => {
  await refreshCachedConfig(false);
  return cachedConfig;
};
const adminAuth = createAuthMiddleware(getConfig, { allowLocalhost: true });

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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", adminAuth);

app.get("/api/config", async (_req, res) => {
  await refreshCachedConfig(true);
  res.json(cachedConfig);
});

app.put("/api/config", async (req, res) => {
  cachedConfig = await writeConfig(req.body);
  try {
    configMtimeMs = (await fs.stat(getConfigPath())).mtimeMs;
  } catch {
    configMtimeMs = Date.now();
  }
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

app.post("/api/auth/antigravity/code", async (req, res) => {
  try {
    res.json(submitAntigravityAuthCode(req.body?.code));
    invalidateStatusCache();
  } catch (error) {
    res.status(400).json({
      error: { message: error.message, type: "routerbot_antigravity_auth_code_error" }
    });
  }
});

app.post("/api/providers/:provider/models", async (req, res) => {
  const config = await getConfig();
  const provider = req.params.provider;
  const storedConfig = config.providers[provider];
  if (!storedConfig) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }

  const providerConfig = {
    ...storedConfig,
    ...(req.body?.provider && typeof req.body.provider === "object" ? req.body.provider : {})
  };

  try {
    const models = await listModels(provider, providerConfig, { refresh: true });
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
        type: "routerbot_model_list_error",
        provider
      }
    });
  }
});

async function refreshAllProviderModels() {
  const config = await getConfig();
  const providers = config.providers ?? {};
  let nextProviders = { ...providers };
  let changed = false;

  for (const [provider, providerConfig] of Object.entries(providers)) {
    if (providerConfig.enabled === false) {
      continue;
    }
    try {
      const models = await listModels(provider, providerConfig);
      nextProviders = {
        ...nextProviders,
        [provider]: { ...providerConfig, models }
      };
      changed = true;
      addLog({
        type: "models",
        provider,
        level: "info",
        message: `Startup refresh loaded ${models.length} models`
      });
    } catch (error) {
      addLog({
        type: "models",
        provider,
        level: "warn",
        message: `Startup model refresh skipped: ${error.message}`
      });
    }
  }

  if (changed) {
    cachedConfig = await writeConfig({ ...config, providers: nextProviders });
  }
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

app.get("/api/tunnels", async (_req, res) => {
  const config = await getConfig();
  try {
    const synced = await syncCursorBaseUrl(config, { persist: true });
    if (synced.changed) {
      cachedConfig = synced.config;
    }
    res.json({ ...synced.status, effectiveCursorBaseUrl: synced.effectiveCursorBaseUrl });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

app.post("/api/tunnels/cloudflared/install", async (_req, res) => {
  try {
    res.json(await installCloudflared());
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

app.post("/api/tunnels/cloudflared/start", async (_req, res) => {
  const config = await getConfig();
  try {
    res.json(await startCloudflared(config.server.port));
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

app.post("/api/tunnels/cloudflared/stop", async (_req, res) => {
  try {
    await stopCloudflared();
    const synced = await syncCursorBaseUrl(cachedConfig, { persist: true });
    cachedConfig = synced.config;
    res.json({ ok: true, effectiveCursorBaseUrl: synced.effectiveCursorBaseUrl });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

app.post("/api/tunnels/ngrok/start", async (_req, res) => {
  const config = await getConfig();
  const tunnels = config.server.tunnels ?? {};
  try {
    res.json(
      await startNgrok(config.server.port, tunnels.ngrokAuthtoken ?? "", tunnels.ngrokDomain ?? "")
    );
  } catch (error) {
    res.status(400).json({ error: { message: error.message } });
  }
});

app.post("/api/tunnels/ngrok/stop", async (_req, res) => {
  try {
    await stopNgrok();
    const synced = await syncCursorBaseUrl(cachedConfig, { persist: true });
    cachedConfig = synced.config;
    res.json({ ok: true, effectiveCursorBaseUrl: synced.effectiveCursorBaseUrl });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

registerOpenAiRoutes(app, getConfig);

const host = process.env.ROUTERBOT_HOST ?? cachedConfig.server.host;
const port = Number(process.env.ROUTERBOT_PORT ?? cachedConfig.server.port);

app.listen(port, host, async () => {
  console.log(`RouterBot dashboard: http://${host}:${port}`);
  console.log(`Cursor model:        ${cachedConfig.server.exposedModel}`);
  console.log(`API key:             ${cachedConfig.server.apiKey ? "(configured)" : "(missing — set ROUTERBOT_API_KEY)"}`);
  const ts = tailscaleUrls(cachedConfig.server);
  if (ts) {
    console.log(`Tailnet dashboard:   ${ts.tailnetDashboard}`);
    console.log(`RouterBot base URL:  ${ts.cursorBaseUrl}`);
    console.log(`Run: ./scripts/tailscale-setup.sh (once) to bind Tailscale ports`);
  } else {
    console.log(`RouterBot base URL:  http://${host}:${port}/v1`);
    console.log(`Set server.tailscaleHost in config for Tailscale URLs`);
  }

  const tunnels = cachedConfig.server.tunnels;
  if (tunnels?.autostartCloudflared) {
    try {
      const result = await startCloudflared(port);
      if (result.url) {
        console.log(`Cloudflared tunnel:  ${result.url}`);
      }
    } catch (error) {
      console.warn(`Cloudflared autostart failed: ${error.message}`);
    }
  }
  if (tunnels?.autostartNgrok && tunnels.ngrokAuthtoken) {
    try {
      const result = await startNgrok(port, tunnels.ngrokAuthtoken, tunnels.ngrokDomain ?? "");
      if (result.url) {
        console.log(`ngrok tunnel:        ${result.url}`);
      }
    } catch (error) {
      console.warn(`ngrok autostart failed: ${error.message}`);
    }
  }

  void refreshAllProviderModels().catch((error) => {
    console.warn(`Provider model refresh failed: ${error.message}`);
  });
});
