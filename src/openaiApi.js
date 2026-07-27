import { Router } from "express";
import { createAuthMiddleware } from "./auth.js";
import { extractCursorMode } from "./cursorMode.js";
import { classifyTask } from "./taskClassifier.js";
import { LEGACY_EXPOSED_MODEL_ALIAS } from "./defaultConfig.js";
import { extractParagonTask, resolveExplicitTask } from "./paragonTask.js";
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
import { listNamedRouteModels, resolveNamedRouteProvider } from "./namedRoutes.js";
import {
  buildResponseObject,
  looksLikeResponsesPayload,
  responsesInputToPrompt,
  responsesToChatCompletion,
  sanitizeResponsesPayload
} from "./responsesFormat.js";
import { streamChatFromResponsesInput, streamResponsesSse } from "./responsesStream.js";
import { recordShadowRoutingDecision } from "./smartRouteShadow.js";

function logParagonRequest(message, { level = "info", provider = "paragon" } = {}) {
  addLog({ type: "request", provider, level, message });
}

function listModels(config) {
  const exposed = config.server.exposedModel;
  const named = listNamedRouteModels(config);
  const seen = new Set();
  const data = [];
  if (exposed) {
    seen.add(exposed);
    data.push({ id: exposed, object: "model", created: 0, owned_by: "paragon" });
    // Deprecated alias, kept for one migration release so existing clients
    // pinned to the pre-rename model id keep resolving.
    if (!seen.has(LEGACY_EXPOSED_MODEL_ALIAS)) {
      seen.add(LEGACY_EXPOSED_MODEL_ALIAS);
      data.push({ id: LEGACY_EXPOSED_MODEL_ALIAS, object: "model", created: 0, owned_by: "paragon" });
    }
  }
  for (const model of named) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    data.push(model);
  }
  return data;
}

function createV1Router(getConfig) {
  const router = Router();

  router.get("/models", async (req, res) => {
    const config = await getConfig();
    logParagonRequest(`GET ${req.baseUrl}/models`);
    res.json({ object: "list", data: listModels(config) });
  });

  router.get("/models/:id", async (req, res) => {
    const config = await getConfig();
    logParagonRequest(`GET ${req.baseUrl}/models/${req.params.id}`);
    const model = listModels(config).find((m) => m.id === req.params.id);
    if (!model) {
      res.status(404).json({
        error: { message: `Model '${req.params.id}' not found`, type: "not_found" }
      });
      return;
    }
    res.json(model);
  });

  router.post("/chat/completions", async (req, res) => {
    const body = req.body ?? {};
    const responsesCompat = looksLikeResponsesPayload(body);
    const pathLabel = responsesCompat
      ? `POST ${req.baseUrl}/chat/completions (responses-compat)`
      : `POST ${req.baseUrl}/chat/completions`;
    await handleGeneration(req, res, getConfig, {
      pathLabel,
      streamKind: responsesCompat ? "chat-from-responses" : "chat",
      bodyForPrompt: responsesCompat ? sanitizeResponsesPayload(body) : body,
      useResponsesInput: responsesCompat
    });
  });

  router.post("/responses", async (req, res) => {
    const body = sanitizeResponsesPayload(req.body ?? {});
    await handleGeneration(req, res, getConfig, {
      pathLabel: body.stream ? `POST ${req.baseUrl}/responses (stream)` : `POST ${req.baseUrl}/responses`,
      streamKind: "responses",
      bodyForPrompt: body,
      useResponsesInput: true
    });
  });

  router.get("/responses/:id", (req, res) => {
    logParagonRequest(`GET ${req.baseUrl}/responses/:id → 404`);
    res.status(404).json({
      error: {
        message: "Stored responses are not supported",
        type: "not_found"
      }
    });
  });

  return router;
}

export function registerOpenAiRoutes(app, getConfig) {
  const auth = createAuthMiddleware(getConfig, { allowLocalhost: false });
  const router = createV1Router(getConfig);
  app.use("/v1", auth, router);
  app.use("/v1/cursor", auth, router);
}

async function resolveTask(prompt, config, cursorMode, body, headers) {
  const explicitTask = resolveExplicitTask(extractParagonTask(body, headers), config);
  if (explicitTask) {
    return explicitTask;
  }

  if (cursorMode && config.routing?.taskRoutes?.[cursorMode]) {
    return cursorMode;
  }

  const classified = await classifyTask(prompt, config);

  if (
    !cursorMode &&
    Array.isArray(body?.messages) &&
    !("input" in body) &&
    classified === "code" &&
    config.routing?.taskRoutes?.ask
  ) {
    return "ask";
  }

  return classified;
}

function responseModelName(body, config) {
  const named = resolveNamedRouteProvider(body?.model, config);
  return named?.routeName ?? config.server.exposedModel;
}

async function handleGeneration(req, res, getConfig, options) {
  const config = await getConfig();
  const { pathLabel, streamKind, bodyForPrompt, useResponsesInput } = options;
  const body = req.body ?? {};
  const cursorMode = extractCursorMode(body, req.headers);
  const prompt = useResponsesInput
    ? responsesInputToPrompt(bodyForPrompt)
    : messagesToPrompt(bodyForPrompt.messages);
  const responseModel = responseModelName(body, config);

  let task;
  let primary;
  const named = resolveNamedRouteProvider(body?.model, config);
  if (named) {
    task = named.routeName;
    primary = pickEnabledProvider(config, named.provider);
  } else {
    task = await resolveTask(prompt, config, cursorMode, body, req.headers);
    primary = pickEnabledProvider(
      config,
      config.routing.taskRoutes[task] ?? config.routing.defaultProvider
    );
  }

  recordShadowRoutingDecision({ body: bodyForPrompt, headers: req.headers, config, legacyTask: task, legacyProvider: primary });

  const attempts = buildProviderAttempts(config, primary);
  const started = Date.now();
  const streamSuffix = req.body?.stream ? " (stream)" : "";
  const modeLabel = cursorMode ? ` · cursor ${cursorMode}` : "";
  logParagonRequest(`${pathLabel}${streamSuffix}${modeLabel} · ${task} → ${primary}`, { provider: primary });
  addLog({
    type: "route",
    provider: primary,
    level: "info",
    message: `Route ${task} -> ${primary} (${config.providers[primary].model})`
  });

  const runOnce = async (onChunk) => {
    const { provider, result, providerFallbackUsed } = await runWithFallback(
      attempts,
      prompt,
      onChunk,
      { cursorMode }
    );
    const durationMs = Date.now() - started;
    const content = sanitizeAssistantContent(result.stdout);
    return { provider, routedProvider: primary, durationMs, content, providerFallbackUsed };
  };

  try {
    if (req.body?.stream) {
      if (streamKind === "responses") {
        await streamResponsesSse({
          res,
          config,
          model: responseModel,
          onGenerate: (onChunk) =>
            runOnce((chunk) => onChunk(sanitizeAssistantContent(chunk))).then((result) => {
              logParagonRequest(
                `${pathLabel} → 200 (${result.durationMs}ms) via ${result.provider}`,
                { provider: result.provider }
              );
              return result;
            })
        });
        return;
      }

      if (streamKind === "chat-from-responses") {
        await streamChatFromResponsesInput({
          res,
          config,
          model: responseModel,
          onGenerate: (onChunk) =>
            runOnce((chunk) => onChunk(sanitizeAssistantContent(chunk))).then((result) => {
              logParagonRequest(
                `${pathLabel} → 200 (${result.durationMs}ms) via ${result.provider}`,
                { provider: result.provider }
              );
              return result;
            })
        });
        return;
      }

      await streamCompletion({
        res,
        config,
        attempts,
        prompt,
        started,
        pathLabel,
        cursorMode,
        responseModel
      });
      return;
    }

    const { provider, routedProvider, durationMs, content } = await runOnce();
    logParagonRequest(`${pathLabel} → 200 (${durationMs}ms) via ${provider}`, { provider });

    if (streamKind === "responses") {
      res.json(
        buildResponseObject({ model: responseModel, content, provider, routedProvider, durationMs })
      );
      return;
    }
    if (streamKind === "chat-from-responses") {
      res.json(
        responsesToChatCompletion(
          buildResponseObject({ model: responseModel, content, provider, routedProvider, durationMs })
        )
      );
      return;
    }
    res.json(
      chatCompletion({
        model: responseModel,
        content,
        durationMs,
        provider,
        routedProvider: primary
      })
    );
  } catch (error) {
    logParagonRequest(`${pathLabel} → 500`, { level: "error", provider: primary });
    addLog({ type: "error", provider: primary, level: "error", message: error.message });
    res.status(500).json({
      error: {
        message: CLIENT_ERROR_MESSAGE,
        type: "paragon_provider_error",
        provider: primary
      }
    });
  }
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

async function runWithFallback(attempts, prompt, onChunk, options = {}) {
  const { cursorMode } = options;
  let lastError;

  for (let index = 0; index < attempts.length; index += 1) {
    const { name, config: providerConfig } = attempts[index];
    const pendingChunks = [];

    try {
      const result = await runProvider(
        name,
        providerConfig,
        prompt,
        onChunk ? (chunk) => pendingChunks.push(chunk) : undefined,
        { cursorMode }
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
      return {
        provider: name,
        result,
        providerFallbackUsed: index > 0
      };
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

async function streamCompletion({ res, config, attempts, prompt, started, pathLabel, cursorMode, responseModel }) {
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
        model: responseModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });
      roleSent = true;
    }
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
    });
  };

  try {
    const { provider, result } = await runWithFallback(attempts, prompt, onChunk, { cursorMode });
    const durationMs = Date.now() - started;
    logParagonRequest(`${pathLabel} (stream) → 200 (${durationMs}ms) via ${provider}`, { provider });
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      paragon: { provider, durationMs, contentLength: sanitizeAssistantContent(result.stdout).length }
    });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    logParagonRequest(`${pathLabel} (stream) → error`, {
      level: "error",
      provider: attempts[0]?.name ?? "paragon"
    });
    if (!roleSent) {
      send({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });
    }
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
      choices: [{ index: 0, delta: { content: CLIENT_ERROR_MESSAGE }, finish_reason: null }]
    });
    send({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
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
