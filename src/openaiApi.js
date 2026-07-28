import { createAuthMiddleware } from "./auth.js";
import { classifyTask } from "./taskClassifier.js";
import { LEGACY_EXPOSED_MODEL_ALIAS } from "./defaultConfig.js";
import { messagesToPrompt } from "./prompt.js";
import { runProvider } from "./cli.js";
import { addLog } from "./logStore.js";
import {
  allProvidersFailedMessage,
  buildProviderAttempts,
  CLIENT_ERROR_MESSAGE,
  formatProviderError,
  sanitizeAssistantContent
} from "./providerFallback.js";

function logParagonRequest(message, { level = "info", provider = "paragon" } = {}) {
  addLog({ type: "request", provider, level, message });
}

export function registerOpenAiRoutes(app, getConfig) {
  app.use("/v1", createAuthMiddleware(getConfig, { allowLocalhost: false }));

  app.get("/v1/models", async (req, res) => {
    const config = await getConfig();
    logParagonRequest("GET /v1/models");
    res.json({
      object: "list",
      data: [
        {
          id: config.server.exposedModel,
          object: "model",
          created: 0,
          owned_by: "paragon"
        },
        // Deprecated alias, kept for one migration release so existing
        // clients pinned to the pre-rename model id keep resolving.
        {
          id: LEGACY_EXPOSED_MODEL_ALIAS,
          object: "model",
          created: 0,
          owned_by: "paragon"
        }
      ]
    });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const config = await getConfig();
    const prompt = messagesToPrompt(req.body.messages);
    const task = classifyTask(prompt);
    const routedProvider = config.routing.taskRoutes[task] ?? config.routing.defaultProvider;
    const primary = pickEnabledProvider(config, routedProvider);
    const attempts = buildProviderAttempts(config, primary);
    const started = Date.now();
    logParagonRequest(
      req.body.stream
        ? `POST /v1/chat/completions (stream) · task ${task} → ${primary}`
        : `POST /v1/chat/completions · task ${task} → ${primary}`,
      { provider: primary }
    );

    addLog({
      type: "route",
      provider: primary,
      level: "info",
      message: `Task ${task} -> ${primary} (${config.providers[primary].model})`
    });

    try {
      if (req.body.stream) {
        await streamCompletion({ res, config, attempts, prompt, started });
        return;
      }

      const { provider, result } = await runWithFallback(attempts, prompt);
      const durationMs = Date.now() - started;
      logParagonRequest(
        `POST /v1/chat/completions → 200 (${durationMs}ms) via ${provider}${provider !== primary ? ` (routed ${primary})` : ""}`,
        { provider }
      );
      res.json(
        chatCompletion({
          model: config.server.exposedModel,
          content: sanitizeAssistantContent(result.stdout),
          durationMs,
          provider,
          routedProvider: primary
        })
      );
    } catch (error) {
      logParagonRequest(`POST /v1/chat/completions → ${res.statusCode ?? 500}`, {
        level: "error",
        provider: primary
      });
      addLog({
        type: "error",
        provider: primary,
        level: "error",
        message: error.message
      });
      res.status(500).json({
        error: {
          message: CLIENT_ERROR_MESSAGE,
          type: "paragon_provider_error",
          provider: primary
        }
      });
    }
  });
}

function pickEnabledProvider(config, preferred) {
  if (config.providers[preferred]?.enabled) {
    return preferred;
  }
  const fallback = Object.entries(config.providers).find(([, value]) => value.enabled);
  if (!fallback) {
    throw new Error("No providers are enabled");
  }
  return fallback[0];
}

async function runWithFallback(attempts, prompt, onChunk) {
  let lastError;

  for (let index = 0; index < attempts.length; index += 1) {
    const { name, config: providerConfig } = attempts[index];
    const pendingChunks = [];

    try {
      const result = await runProvider(
        name,
        providerConfig,
        prompt,
        onChunk ? (chunk) => pendingChunks.push(chunk) : undefined
      );

      if (onChunk) {
        for (const chunk of pendingChunks) {
          onChunk(sanitizeAssistantContent(chunk));
        }
      }

      if (index > 0) {
        addLog({
          type: "fallback",
          provider: name,
          level: "info",
          message: `Recovered using ${name} after ${attempts[index - 1].name} failed`
        });
      }
      return { provider: name, result };
    } catch (error) {
      pendingChunks.length = 0;
      lastError = error;
      addLog({
        type: "error",
        provider: name,
        level: "warn",
        message: formatProviderError(error)
      });
      if (index < attempts.length - 1) {
        addLog({
          type: "fallback",
          provider: attempts[index + 1].name,
          level: "info",
          message: `Trying ${attempts[index + 1].name} after ${name} failed`
        });
      }
    }
  }

  const detail = allProvidersFailedMessage(attempts, lastError);
  addLog({ type: "error", provider: attempts[0]?.name, level: "error", message: detail });
  throw new Error(CLIENT_ERROR_MESSAGE);
}

async function streamCompletion({ res, config, attempts, prompt, started }) {
  const id = `chatcmpl-${Date.now()}`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let roleSent = false;
  const onChunk = (chunk) => {
    if (!roleSent) {
      send({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: config.server.exposedModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });
      roleSent = true;
    }
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: config.server.exposedModel,
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
    });
  };

  try {
    const { provider } = await runWithFallback(attempts, prompt, onChunk);
    const durationMs = Date.now() - started;
    logParagonRequest(`POST /v1/chat/completions (stream) → 200 (${durationMs}ms) via ${provider}`, {
      provider
    });
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: config.server.exposedModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      paragon: { provider, durationMs: Date.now() - started }
    });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    logParagonRequest(`POST /v1/chat/completions (stream) → error`, {
      level: "error",
      provider: attempts[0]?.name ?? "paragon"
    });
    if (!roleSent) {
      send({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: config.server.exposedModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });
    }
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: config.server.exposedModel,
      choices: [
        {
          index: 0,
          delta: { content: error.message },
          finish_reason: null
        }
      ]
    });
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: config.server.exposedModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function chatCompletion({ model, content, durationMs, provider, routedProvider }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    paragon: {
      durationMs,
      provider,
      routedProvider,
      fallback: provider !== routedProvider
    },
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}
