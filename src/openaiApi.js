import { createAuthMiddleware } from "./auth.js";
import { classifyTask } from "./taskClassifier.js";
import { LEGACY_EXPOSED_MODEL_ALIAS } from "./defaultConfig.js";
import { createIsolatedRuntimeDir, releaseIsolatedRuntimeDir } from "./executionSandbox.js";
import { messagesToPrompt } from "./prompt.js";
import { runProvider } from "./cli.js";
import { addLog } from "./logStore.js";
import { createBoundedResponseAccumulator, estimateRequestContext } from "./orchestration/contextEstimator.js";
import { classifyError, boundedDiagnostic } from "./orchestration/errorClassification.js";
import { selectRoute, buildRankedAttempts } from "./routing/router.js";
import { extractRoutingHints, requiresJsonValidation, isValidJson } from "./routing/hints.js";
import { getBenchmarkData } from "./routing/benchmarks.js";
import {
  activeExecutionCount,
  applyFallbackLimit,
  beginExecution,
  checkConcurrency,
  checkContextCeiling,
  endExecution,
  filterOpenCircuits,
  recordProviderResult
} from "./orchestration/liveEnforcement.js";
import {
  allProvidersFailedMessage,
  buildProviderAttempts,
  CLIENT_ERROR_MESSAGE,
  formatProviderError,
  sanitizeAssistantContent
} from "./providerFallback.js";

function enforcementErrorResponse(res, { reasonCode, message }, status = 429) {
  res.status(status).json({
    error: {
      message,
      type: "paragon_live_enforcement_error",
      code: reasonCode
    }
  });
}

/** Records a blocking live-enforcement decision so it shows in Governor Actions, same as shadow-proposed ones. */
async function recordEnforcementDecision(orchestration, telemetry, { reasonCode, message }) {
  if (!telemetry || !orchestration) {
    return;
  }
  await safely(() =>
    orchestration.decisions.record(
      { jobId: telemetry.run.jobId, sessionId: telemetry.run.sessionId, runId: telemetry.run.id, now: new Date().toISOString() },
      [
        {
          policyRule: reasonCode,
          observedValue: true,
          threshold: true,
          proposedAction: "blocked_request",
          explanation: `ENFORCED (live mode): ${message}`,
          confidence: "high",
          missingEvidence: []
        }
      ]
    )
  );
}

function logParagonRequest(message, { level = "info", provider = "paragon" } = {}) {
  addLog({ type: "request", provider, level, message });
}

/**
 * Shadow-only instrumentation hook. All orchestration recording is
 * best-effort — a storage failure must never affect the actual response.
 */
async function safely(fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    console.warn(`orchestration: instrumentation error (non-fatal): ${error.message}`);
    return fallback;
  }
}

export function registerOpenAiRoutes(app, getConfig, orchestration, getStatuses = () => ({})) {
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
    const policy = config.orchestration;
    const prompt = messagesToPrompt(req.body.messages);
    const task = classifyTask(prompt);

    // PARAGON-D-004: deterministic candidate scoring over the model
    // registry is the real live routing decision — provider AND model,
    // not just provider from a fixed task->provider table. taskRoutes is
    // still read (inside selectRoute) as a strong preference signal, not
    // an absolute override. See src/routing/router.js.
    const hints = extractRoutingHints(req.headers);
    const contextEstimate = estimateRequestContext(req.body);

    // PARAGON-D-004B-R: PARAGON is a transparent OpenAI-compatible model
    // gateway. Clients such as Cursor supply only messages — no workspace
    // id, path, or mode is ever required or read from the request. Every
    // provider invocation instead runs inside its own throwaway directory
    // (never process.cwd(), never a client-supplied path) so it cannot
    // affect PARAGON's own checkout or any real project.
    const runtimeDir = createIsolatedRuntimeDir();
    let primary;
    let primaryModel;

    try {
      // Cached (6h TTL) — this almost never triggers a real network call on
      // the hot request path. Empty rows when no OpenRouter key is
      // configured, which selectRoute treats as "internal-only scoring".
      const benchmarks = await safely(() => getBenchmarkData(config.integrations?.openrouterApiKey), { rows: [] });
      let route = selectRoute({
        config,
        statuses: getStatuses(),
        taskProfile: {
          taskType: task,
          estimatedInputTokens: contextEstimate.estimatedInputTokens
        },
        hints,
        benchmarkRows: benchmarks?.rows ?? []
      });
      let attempts = route ? buildRankedAttempts(route.ranking, config) : [];
      if (!route || !attempts.length) {
        // Safety net: no eligible candidate in the registry (e.g. nothing
        // enabled/healthy, or a registry build hiccup) — fall back to the
        // old static default rather than a hard denial of service. Recorded
        // with its own reason code so this is never silently confused with
        // an actual scored decision.
        route = null;
        const routedProvider = config.routing.taskRoutes[task] ?? config.routing.defaultProvider;
        const staticPrimary = pickEnabledProvider(config, routedProvider);
        attempts = buildProviderAttempts(config, staticPrimary);
      }
      primary = route ? route.provider : attempts[0]?.name;
    primaryModel = attempts[0]?.config?.model || config.providers[primary]?.model;
    const routeReasonCode = route?.reasonCode ?? "fallback.staticDefault";
    res.set({
      "X-Paragon-Route-Reason": routeReasonCode,
      "X-Paragon-Route-Model": primaryModel || ""
    });
    const started = Date.now();

    // Master switch: orchestration.enabled === false means no telemetry at
    // all, not even correlation headers — distinct from mode:"off", which
    // still records correlation/run/session state but suppresses governor
    // decisions and live enforcement (see evaluateShadowGovernor and
    // liveEnforcement.js). See docs/operations/ORCHESTRATION_OBSERVABILITY.md
    // for the full enabled/off/live semantics (PARAGON-D-002A, PARAGON-D-003R).
    const orchestrationActive = Boolean(orchestration && policy?.enabled);
    const telemetry = orchestrationActive
      ? await safely(() => orchestration.beginRequest(req.headers, req.body))
      : null;
    if (telemetry) {
      res.set(telemetry.responseHeaders);
      await safely(() =>
        orchestration.recordRoute(telemetry.run.id, { provider: primary, model: primaryModel, routeClassification: task, fallbackPosition: 0 })
      );
    }

    const isLive = policy?.mode === "live";

    // --- Live enforcement gates, checked before any provider is dispatched.
    // Each blocking condition finishes the telemetry run as a bounded
    // failure (so it's visible in Activity/Governor Actions) and returns an
    // OpenAI-compatible structured error — nothing here is a proposal.
    if (isLive && telemetry?.enforcement) {
      const { reasonCode, message, rolloverRequired } = telemetry.enforcement;
      addLog({ type: "enforcement", provider: primary, level: "warn", message: `${reasonCode}: ${message}` });
      await safely(() =>
        orchestration.finishRequest(telemetry, { success: false, provider: primary, errorClassification: "CANCELLED", errorDiagnostic: message })
      );
      enforcementErrorResponse(res, { reasonCode, message: rolloverRequired ? `${message} A new session is required.` : message });
      return;
    }

    if (isLive) {
      const contextCheck = checkContextCeiling(policy, telemetry?.contextEstimate?.estimatedInputTokens ?? 0);
      if (contextCheck.blocked) {
        addLog({ type: "enforcement", provider: primary, level: "warn", message: `${contextCheck.reasonCode}: ${contextCheck.message}` });
        await recordEnforcementDecision(orchestration, telemetry, contextCheck);
        if (telemetry) {
          await safely(() =>
            orchestration.finishRequest(telemetry, { success: false, provider: primary, errorClassification: "CANCELLED", errorDiagnostic: contextCheck.message })
          );
        }
        enforcementErrorResponse(res, contextCheck, 400);
        return;
      }

      const concurrencyCheck = checkConcurrency(policy);
      if (concurrencyCheck.blocked) {
        addLog({ type: "enforcement", provider: primary, level: "warn", message: `${concurrencyCheck.reasonCode}: ${concurrencyCheck.message}` });
        await recordEnforcementDecision(orchestration, telemetry, concurrencyCheck);
        if (telemetry) {
          await safely(() =>
            orchestration.finishRequest(telemetry, { success: false, provider: primary, errorClassification: "CANCELLED", errorDiagnostic: concurrencyCheck.message })
          );
        }
        enforcementErrorResponse(res, concurrencyCheck, 429);
        return;
      }

      attempts = applyFallbackLimit(policy, filterOpenCircuits(attempts));
      if (!attempts.length) {
        const message = "No providers available: all candidates are past the fallback limit or circuit-open.";
        const circuitAllOpen = { reasonCode: "circuitBreaker.allOpen", message };
        addLog({ type: "enforcement", provider: primary, level: "error", message });
        await recordEnforcementDecision(orchestration, telemetry, circuitAllOpen);
        if (telemetry) {
          await safely(() =>
            orchestration.finishRequest(telemetry, { success: false, provider: primary, errorClassification: "UNKNOWN", errorDiagnostic: message })
          );
        }
        enforcementErrorResponse(res, circuitAllOpen, 503);
        return;
      }
    }

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
      message: `Task ${task} -> ${primary} (${primaryModel || "default"}) [${routeReasonCode}]`
    });

    if (isLive) {
      beginExecution();
    }

    try {
      if (req.body.stream) {
        await streamCompletion({ res, config, policy, isLive, attempts, prompt, started, orchestration, telemetry, cwd: runtimeDir });
        return;
      }

      let { provider, result } = await runWithFallback(attempts, prompt, {
        orchestration,
        runId: telemetry?.run.id,
        policy,
        isLive,
        cwd: runtimeDir
      });
      let content = sanitizeAssistantContent(result.stdout);

      // Validation-driven escalation (PARAGON-D-004), kept distinct from
      // service-failure fallback above: PARAGON is a completion proxy with
      // no test-execution loop, so this is the one output contract it can
      // honestly check today — did the response satisfy the structured-
      // output format the caller actually asked for. Streaming responses
      // are not covered (can't validate before the stream is already
      // delivered to the caller).
      if (requiresJsonValidation(req.body) && !hints.disableEscalation && !isValidJson(content)) {
        const triedIndex = attempts.findIndex((a) => a.name === provider);
        const remaining = attempts.slice(triedIndex + 1);
        if (remaining.length) {
          addLog({
            type: "escalation",
            provider,
            level: "warn",
            message: `${provider} response failed json validation — escalating to ${remaining[0].name} (distinct from service-failure fallback)`
          });
          try {
            const escalated = await runWithFallback(remaining, prompt, {
              orchestration,
              runId: telemetry?.run.id,
              policy,
              isLive,
              cwd: runtimeDir
            });
            provider = escalated.provider;
            result = escalated.result;
            content = sanitizeAssistantContent(result.stdout);
          } catch {
            addLog({
              type: "escalation",
              provider,
              level: "error",
              message: "Escalation candidates exhausted — returning the original response despite failed json validation."
            });
          }
        }
      }

      const durationMs = Date.now() - started;
      logParagonRequest(
        `POST /v1/chat/completions → 200 (${durationMs}ms) via ${provider}${provider !== primary ? ` (routed ${primary})` : ""}`,
        { provider }
      );
      if (telemetry) {
        await safely(() =>
          orchestration.finishRequest(telemetry, {
            success: true,
            provider,
            model: attempts.find((a) => a.name === provider)?.config?.model ?? config.providers[provider]?.model,
            fallbackPosition: attempts.findIndex((a) => a.name === provider),
            responseText: content,
            contextEstimate: telemetry.contextEstimate
          })
        );
      }
      res.json(
        chatCompletion({
          model: config.server.exposedModel,
          content,
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
      if (telemetry) {
        await safely(() =>
          orchestration.finishRequest(telemetry, {
            success: false,
            provider: primary,
            errorClassification: classifyError(error),
            errorDiagnostic: boundedDiagnostic(error),
            timeout: classifyError(error) === "TIMEOUT"
          })
        );
      }
      res.status(500).json({
        error: {
          message: CLIENT_ERROR_MESSAGE,
          type: "paragon_provider_error",
          provider: primary
        }
      });
    } finally {
      if (isLive) {
        endExecution();
      }
    }
    } finally {
      releaseIsolatedRuntimeDir(runtimeDir);
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

/**
 * RUN vs ATTEMPT: one call to this function serves one PARAGON request
 * (`run`). Each provider it tries within the configured fallback chain is
 * a separate `attempt`, individually timed and classified — this is what
 * lets orchestration telemetry answer "which specific provider failed,
 * when, and why" rather than only "which provider eventually succeeded"
 * (PARAGON-D-002A). Provider order, selection, and retry policy are
 * unchanged from before this instrumentation existed.
 */
async function runWithFallback(attempts, prompt, { onChunk, orchestration, runId, policy, isLive, cwd } = {}) {
  let lastError;

  for (let index = 0; index < attempts.length; index += 1) {
    const { name, config: providerConfig } = attempts[index];
    const pendingChunks = [];
    const hasNext = index < attempts.length - 1;

    const attemptRecord =
      orchestration && runId
        ? await safely(() =>
            orchestration.beginAttempt(runId, { provider: name, model: providerConfig.model, fallbackPosition: index })
          )
        : null;
    const onSpawn = attemptRecord
      ? (pid) => {
          safely(() => orchestration.recordAttemptProcessId(attemptRecord.id, pid));
        }
      : undefined;

    try {
      const result = await runProvider(
        name,
        providerConfig,
        prompt,
        onChunk ? (chunk) => pendingChunks.push(chunk) : undefined,
        { onSpawn, cwd }
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
      if (attemptRecord) {
        await safely(() => orchestration.finishAttempt(attemptRecord.id, { success: true, followedByAnotherAttempt: false }));
      }
      if (isLive) {
        recordProviderResult(policy, name, true);
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
      if (isLive) {
        recordProviderResult(policy, name, false);
      }
      if (attemptRecord) {
        await safely(() =>
          orchestration.finishAttempt(attemptRecord.id, {
            success: false,
            timeout: classifyError(error) === "TIMEOUT",
            errorClassification: classifyError(error),
            errorDiagnostic: boundedDiagnostic(error),
            fallbackReason: hasNext ? `failed, falling back to ${attempts[index + 1].name}` : "all attempts exhausted",
            followedByAnotherAttempt: hasNext
          })
        );
      }
      if (hasNext) {
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

async function streamCompletion({ res, config, policy, isLive, attempts, prompt, started, orchestration, telemetry, cwd }) {
  const id = `chatcmpl-${Date.now()}`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let roleSent = false;
  // Bounded counters instead of `streamedText += chunk` — a multi-hundred-KB
  // streamed response no longer means a second full copy held in memory
  // purely for telemetry (PARAGON-D-002A).
  const responseAccumulator = createBoundedResponseAccumulator();
  const onChunk = (chunk) => {
    responseAccumulator.push(chunk);
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
    const { provider } = await runWithFallback(attempts, prompt, { onChunk, orchestration, runId: telemetry?.run.id, policy, isLive, cwd });
    const durationMs = Date.now() - started;
    logParagonRequest(`POST /v1/chat/completions (stream) → 200 (${durationMs}ms) via ${provider}`, {
      provider
    });
    if (telemetry) {
      await safely(() =>
        orchestration.finishRequest(telemetry, {
          success: true,
          provider,
          model: attempts.find((a) => a.name === provider)?.config?.model ?? config.providers[provider]?.model,
          fallbackPosition: attempts.findIndex((a) => a.name === provider),
          responseEstimate: responseAccumulator.finish()
        })
      );
    }
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
    if (telemetry) {
      await safely(() =>
        orchestration.finishRequest(telemetry, {
          success: false,
          provider: attempts[0]?.name ?? null,
          errorClassification: classifyError(error),
          errorDiagnostic: boundedDiagnostic(error),
          timeout: classifyError(error) === "TIMEOUT",
          responseEstimate: responseAccumulator.finish()
        })
      );
    }
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
