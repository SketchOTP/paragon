import { createAuthMiddleware } from "./auth.js";
import { classifyTask } from "./taskClassifier.js";
import { LEGACY_EXPOSED_MODEL_ALIAS } from "./defaultConfig.js";
import { createIsolatedRuntimeDir, releaseIsolatedRuntimeDir } from "./executionSandbox.js";
import { messagesToPrompt } from "./prompt.js";
import { runProvider } from "./cli.js";
import { addLog } from "./logStore.js";
import { createBoundedResponseAccumulator, estimateRequestContext } from "./orchestration/contextEstimator.js";
import { classifyError, boundedDiagnostic } from "./orchestration/errorClassification.js";
import { classifyModelFailure } from "./modelCatalog.js";
import { selectAutomaticRoute, verifyPlanAgainstCandidates } from "./routing/automaticRouting.js";
import { extractRoutingHints, requiresJsonValidation, isValidJson } from "./routing/hints.js";
import { getBenchmarkData, matchBenchmarkRow } from "./routing/benchmarks.js";
import { buildTaskProfile } from "./routing/taskProfile.js";
import { unknownUsage } from "./routing/usageEvidence.js";
import {
  applyFailureToPlan,
  planNextAfterFailure,
  PROVIDER_WIDE_FAILURES
} from "./routing/attemptPlan.js";
import {
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

/** Records a blocking live-enforcement decision so it shows in Diagnostics. */
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

/** "on Aug 12" / "at 14:30" — a usage limit is only actionable with its reset. */
function formatResetInstant(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "soon";
  }
  const withinADay = date.getTime() - Date.now() < 24 * 3_600_000;
  return withinADay
    ? `at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : `on ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function logParagonRequest(message, { level = "info", provider = "paragon" } = {}) {
  addLog({ type: "request", provider, level, message });
}

/**
 * Instrumentation hook. All orchestration/telemetry recording is best-effort —
 * a storage failure must never affect the actual response.
 */
async function safely(fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    console.warn(`orchestration: instrumentation error (non-fatal): ${error.message}`);
    return fallback;
  }
}

/**
 * Plain-language failure reason for the product's Recent Activity list.
 * Diagnostics keeps the raw classification and bounded diagnostic; this is
 * what an ordinary user reads, so it must not leak reason codes or stderr.
 */
function friendlyFailureReason(classification, provider, { resetAt = null } = {}) {
  const label = provider ?? "the provider";
  switch (classification) {
    case "QUOTA_EXHAUSTED":
      // Naming the reset turns a dead end into something the user can plan
      // around — it is the single most useful fact about a usage limit.
      return resetAt
        ? `${label} reached its usage limit, which resets ${formatResetInstant(resetAt)}`
        : `${label} reached its usage limit`;
    case "ENTITLEMENT_REQUIRED":
      return `${label} requires a plan upgrade for this model`;
    case "AUTHENTICATION_FAILED":
      return `${label} needs to be signed in again`;
    case "RATE_LIMITED":
      return `${label} was rate limited`;
    case "TIMEOUT":
      return `${label} took too long to respond`;
    case "MODEL_NOT_FOUND":
    case "MODEL_REJECTED":
    case "MODEL_UNAVAILABLE":
      return `the selected model was unavailable on ${label}`;
    case "PROVIDER_OFFLINE":
      return `${label} was unreachable`;
    case "CONFIGURATION_ERROR":
      return `${label} is misconfigured`;
    default:
      return `${label} did not return a response`;
  }
}

export function registerOpenAiRoutes(app, getConfig, orchestration, getStatuses = () => ({}), catalogStore = null, routing = null) {
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
    // Retained only as a coarse label for logs and the activity feed. It is
    // not a routing input — the multidimensional request profile below is.
    const task = classifyTask(prompt);

    const hints = extractRoutingHints(req.headers);
    const contextEstimate = estimateRequestContext(req.body);

    // PARAGON is a transparent OpenAI-compatible model gateway. Clients such
    // as Cursor supply only messages — no workspace id, path, or mode is ever
    // required or read. Every provider invocation runs inside its own
    // throwaway directory (never process.cwd(), never a client-supplied path)
    // so it cannot affect PARAGON's own checkout or any real project.
    const runtimeDir = createIsolatedRuntimeDir();
    let primary;
    let primaryModel;

    try {
      /**
       * Live-enforcement policy gates run BEFORE routing.
       *
       * They are decisions about the *request* (session budget, absolute
       * context ceiling, concurrency), not about candidates, so they do not
       * depend on routing succeeding. Evaluating them after routing meant an
       * oversized request was reported as `no_eligible_model` — every candidate
       * had been excluded by the context gate — instead of the specific,
       * actionable ceiling error the operator configured.
       */
      const orchestrationActive = Boolean(orchestration && policy?.enabled);
      const telemetry = orchestrationActive
        ? await safely(() => orchestration.beginRequest(req.headers, req.body))
        : null;
      if (telemetry) {
        res.set(telemetry.responseHeaders);
      }
      const isLive = policy?.mode === "live";

      if (isLive && telemetry?.enforcement) {
        const { reasonCode, message, rolloverRequired } = telemetry.enforcement;
        addLog({ type: "enforcement", provider: "paragon", level: "warn", message: `${reasonCode}: ${message}` });
        await safely(() =>
          orchestration.finishRequest(telemetry, { success: false, errorClassification: "CANCELLED", errorDiagnostic: message })
        );
        enforcementErrorResponse(res, { reasonCode, message: rolloverRequired ? `${message} A new session is required.` : message });
        return;
      }

      if (isLive) {
        const contextCheck = checkContextCeiling(policy, telemetry?.contextEstimate?.estimatedInputTokens ?? contextEstimate?.estimatedInputTokens ?? 0);
        if (contextCheck.blocked) {
          addLog({ type: "enforcement", provider: "paragon", level: "warn", message: `${contextCheck.reasonCode}: ${contextCheck.message}` });
          await recordEnforcementDecision(orchestration, telemetry, contextCheck);
          if (telemetry) {
            await safely(() =>
              orchestration.finishRequest(telemetry, { success: false, errorClassification: "CANCELLED", errorDiagnostic: contextCheck.message })
            );
          }
          enforcementErrorResponse(res, contextCheck, 400);
          return;
        }

        const concurrencyCheck = checkConcurrency(policy);
        if (concurrencyCheck.blocked) {
          addLog({ type: "enforcement", provider: "paragon", level: "warn", message: `${concurrencyCheck.reasonCode}: ${concurrencyCheck.message}` });
          await recordEnforcementDecision(orchestration, telemetry, concurrencyCheck);
          if (telemetry) {
            await safely(() =>
              orchestration.finishRequest(telemetry, { success: false, errorClassification: "CANCELLED", errorDiagnostic: concurrencyCheck.message })
            );
          }
          enforcementErrorResponse(res, concurrencyCheck, 429);
          return;
        }
      }

      // Attempt-cached — almost never a real network call on the hot request
      // path. Empty rows when no OpenRouter key is configured. Stale data
      // (past MAX_USABLE_AGE_MS since the last *successful* fetch) is withheld
      // from scoring entirely rather than silently applied.
      const benchmarks = await safely(() => getBenchmarkData(config.integrations?.openrouterApiKey), { rows: [], stale: true });
      const benchmarkRows = benchmarks?.stale ? [] : (benchmarks?.rows ?? []);
      if (benchmarks?.enabled && benchmarks?.stale) {
        addLog({
          type: "route",
          provider: "paragon",
          level: "warn",
          message: `routing.benchmarkDataStale: benchmark data age ${benchmarks.dataAgeMs ?? "unknown"}ms exceeds max usable age — scoring internal-only for this request`
        });
      }

      const catalog = catalogStore?.get() ?? null;
      const statuses = getStatuses();

      // The request profile. Multidimensional and deterministic — no LLM call,
      // no network, no randomness — so a decision is reproducible.
      const taskProfile = buildTaskProfile({
        prompt,
        body: req.body,
        estimatedInputTokens: contextEstimate?.estimatedInputTokens ?? null,
        hints,
        options: { largeThreshold: routing?.settings?.unknownLargeContextThresholdTokens ?? 50000 }
      });

      /**
       * THE routing decision. Exactly one computation per request: there is no
       * second engine, no comparison pass, and no mode switch. What this
       * returns is what executes.
       */
      const route = selectAutomaticRoute({
        config,
        statuses,
        catalog,
        telemetryStore: routing?.getTelemetry?.() ?? { entries: {} },
        benchmarkRows,
        taskProfile,
        hints,
        settings: routing?.settings ?? {},
        quotaState: routing?.quotaState ?? null,
        priority: config.routing?.priority
      });

      // A forced route that failed an eligibility gate is a client error,
      // never a silent downgrade to automatic routing.
      if (route?.rejected) {
        addLog({ type: "route", provider: hints.forceProvider ?? "paragon", level: "warn", message: `${route.reasonCode}: ${route.message}` });
        res.set({ "X-Paragon-Route-Reason": route.reasonCode, "X-Paragon-Route-Model": "" });
        res.status(400).json({
          error: { message: route.message, type: "paragon_routing_error", code: route.reasonCode }
        });
        return;
      }

      let plan = route?.attemptPlan ?? [];

      // Availability is never preserved by weakening a constraint: there is no
      // static configured-model fallback, so an empty eligible set is a
      // bounded 503 rather than a dispatch of something unvalidated.
      if (!route?.winner || !plan.length) {
        const message =
          "No eligible model is currently available. Every candidate was excluded by catalog eligibility, provider health, circuit state, context limits, cost ceiling, usage limits, or chat-capability gates.";
        addLog({ type: "route", provider: "paragon", level: "error", message: `routing.noEligibleModel: ${message}` });
        res.set({ "X-Paragon-Route-Reason": "routing.noEligibleModel", "X-Paragon-Route-Model": "" });
        res.status(503).json({
          error: { message, type: "paragon_routing_error", code: "no_eligible_model" }
        });
        return;
      }

      // Integrity assertion immediately before dispatch: nothing may execute
      // that is not a currently-eligible candidate from the same computation
      // that produced the plan.
      const violations = verifyPlanAgainstCandidates(plan, route.ranked, config);
      if (violations.length) {
        const message = "Internal routing integrity check failed: a planned attempt is not a currently eligible model.";
        addLog({
          type: "route",
          provider: "paragon",
          level: "error",
          message: `routing.attemptIntegrityViolation: ${violations.map((v) => `${v.attempt}/${v.model ?? "?"}: ${v.reason}`).join("; ")}`
        });
        res.status(503).json({
          error: { message, type: "paragon_routing_error", code: "no_eligible_model" }
        });
        return;
      }

      primary = route.winner.provider;
      primaryModel = plan[0]?.registryModel ?? route.winner.providerModelId;
      const routeReasonCode = route.reasonCode;
      const usesProviderDefault = Boolean(plan[0]?.providerDefault);
      // Matched for just the selected model rather than re-annotating the
      // whole registry — one lookup instead of one per candidate.
      const primaryBenchmark = benchmarkRows.length ? matchBenchmarkRow(primaryModel, benchmarkRows) : null;
      res.set({
        "X-Paragon-Route-Reason": routeReasonCode,
        "X-Paragon-Route-Model": usesProviderDefault ? "provider-default" : primaryModel || "",
        "X-Paragon-Model-State": usesProviderDefault ? "exposed-default" : route.winner.modelState ?? "unknown",
        "X-Paragon-Routing-Priority": route.priority,
        "X-Paragon-Benchmark-Match": primaryBenchmark?.matchMethod ?? "none"
      });
      const started = Date.now();

      // The plan is a decision, not an execution. The provider-model that
      // actually ran is recorded separately, after a response exists.
      routing?.routeActivity?.recordPlanned({
        taskType: task,
        priority: route.priority,
        attemptPlan: route.attemptPlanSummary
      });

      // Bound to this request's profile so telemetry accumulates per
      // (provider, model, execution profile, task shape).
      const recordAttemptOutcome = routing?.recordOutcome
        ? (observation) => {
            routing.recordOutcome({
              ...observation,
              taskProfile,
              structuredOutputRequired: requiresJsonValidation(req.body)
            });
          }
        : undefined;

      if (telemetry) {
        await safely(() =>
          orchestration.recordRoute(telemetry.run.id, { provider: primary, model: primaryModel, routeClassification: task, fallbackPosition: 0 })
        );
      }

      // --- Candidate-dependent enforcement, checked before any dispatch.
      if (isLive) {
        plan = applyFallbackLimit(policy, filterOpenCircuits(plan));
        if (!plan.length) {
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
        message: `Task ${task} -> ${primary} (${primaryModel || "default"}) [${routeReasonCode}, priority ${route.priority}]`
      });

      if (isLive) {
        beginExecution();
      }

      const planContext = {
        orchestration,
        runId: telemetry?.run.id,
        policy,
        isLive,
        cwd: runtimeDir,
        catalogStore,
        recordOutcome: recordAttemptOutcome,
        routing,
        // Only meaningful when the caller actually asked for structured output;
        // otherwise there is no contract to check and compliance stays unrecorded.
        validateResponse: requiresJsonValidation(req.body)
          ? (stdout) => isValidJson(sanitizeAssistantContent(stdout))
          : undefined
      };

      try {
        if (req.body.stream) {
          await streamCompletion({ res, config, plan, prompt, started, orchestration, telemetry, planContext, routing, task });
          return;
        }

        let outcome = await runPlan(plan, prompt, planContext);
        let content = sanitizeAssistantContent(outcome.result.stdout);

        // Validation-driven escalation, kept distinct from service-failure
        // fallback: PARAGON is a completion proxy with no test-execution loop,
        // so this is the one output contract it can honestly check — did the
        // response satisfy the structured-output format the caller asked for.
        // Streaming responses are not covered (can't validate before the
        // stream is already delivered).
        if (requiresJsonValidation(req.body) && !hints.disableEscalation && !isValidJson(content)) {
          const remaining = outcome.remainingPlan;
          if (remaining.length) {
            addLog({
              type: "escalation",
              provider: outcome.provider,
              level: "warn",
              message: `${outcome.provider} response failed json validation — escalating to ${remaining[0].name} (distinct from service-failure fallback)`
            });
            try {
              const escalated = await runPlan(remaining, prompt, planContext);
              outcome = { ...escalated, escalated: true, fallback: true, recoveredFrom: outcome.provider };
              content = sanitizeAssistantContent(escalated.result.stdout);
            } catch {
              addLog({
                type: "escalation",
                provider: outcome.provider,
                level: "error",
                message: "Escalation candidates exhausted — returning the original response despite failed json validation."
              });
            }
          }
        }

        const durationMs = Date.now() - started;
        recordSuccessfulRoute({ routing, outcome, durationMs, plan });
        logParagonRequest(
          `POST /v1/chat/completions → 200 (${durationMs}ms) via ${outcome.provider}${outcome.provider !== primary ? ` (routed ${primary})` : ""}`,
          { provider: outcome.provider }
        );
        if (telemetry) {
          await safely(() =>
            orchestration.finishRequest(telemetry, {
              success: true,
              provider: outcome.provider,
              model: outcome.attempt.registryModel,
              fallbackPosition: outcome.fallbackPosition,
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
            provider: outcome.provider,
            routedProvider: primary,
            usage: outcome.usage
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
        routing?.routeActivity?.recordRequest({
          success: false,
          provider: error.lastProvider ?? primary,
          model: error.lastModel ?? primaryModel,
          durationMs: Date.now() - started,
          failureReason: error.friendlyReason ?? friendlyFailureReason(error.lastClassification, error.lastProvider ?? primary)
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

/** Records the executed route plus the product-facing activity event. */
function recordSuccessfulRoute({ routing, outcome, durationMs, plan }) {
  routing?.routeActivity?.recordExecuted({
    provider: outcome.provider,
    model: outcome.attempt.providerDefault ? "provider-default" : outcome.attempt.registryModel,
    providerDefault: Boolean(outcome.attempt.providerDefault)
  });
  const firstFailure = outcome.failures[0] ?? null;
  routing?.routeActivity?.recordRequest({
    success: true,
    provider: outcome.provider,
    model: outcome.attempt.providerDefault ? "provider-default" : outcome.attempt.registryModel,
    durationMs,
    // Fallback is measured against what actually happened, not against the
    // plan head, so a request that succeeded first try is never reported as a
    // recovery and vice versa.
    fallback: outcome.failures.length > 0,
    recoveredFrom: firstFailure?.provider ?? null,
    recoveredFromReason: firstFailure?.failureReason ?? null
  });
}

/**
 * Executes a bounded attempt plan.
 *
 * RUN vs ATTEMPT: one call serves one PARAGON request (`run`). Each
 * provider-model-profile it tries is a separate `attempt`, individually timed
 * and classified.
 *
 * Failure handling is **classified**, which is what makes same-provider
 * fallback possible: a model-specific rejection advances to the next eligible
 * model from the same provider, while a provider-wide failure (auth, quota,
 * entitlement, offline, misconfigured) abandons that provider's remaining
 * attempts entirely. A failed attempt is never retried within one request
 * beyond its bounded retry budget, so no provider-model is ever executed twice.
 */
async function runPlan(initialPlan, prompt, context = {}) {
  const { onChunk, orchestration, runId, policy, isLive, cwd, catalogStore, recordOutcome, routing, validateResponse } = context;
  const attemptKey = (attempt) => `${attempt.name}/${attempt.registryModel}/${attempt.executionProfile ?? "default"}`;

  let plan = [...initialPlan];
  const retries = new Map();
  const failures = [];
  let lastError;
  let attemptIndex = 0;

  while (plan.length) {
    const attempt = plan[0];
    const { name, config: providerConfig } = attempt;
    const key = attemptKey(attempt);
    const pendingChunks = [];

    const attemptRecord =
      orchestration && runId
        ? await safely(() =>
            orchestration.beginAttempt(runId, { provider: name, model: providerConfig.model, fallbackPosition: attemptIndex })
          )
        : null;
    const onSpawn = attemptRecord
      ? (pid) => {
          safely(() => orchestration.recordAttemptProcessId(attemptRecord.id, pid));
        }
      : undefined;

    const attemptStartedAt = Date.now();
    attemptIndex += 1;

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

      if (failures.length) {
        addLog({
          type: "fallback",
          provider: name,
          level: "info",
          message: `Recovered using ${name}/${attempt.registryModel} after ${failures[failures.length - 1].provider} failed`
        });
      }
      if (attemptRecord) {
        await safely(() => orchestration.finishAttempt(attemptRecord.id, { success: true, followedByAnotherAttempt: false }));
      }
      if (isLive) {
        recordProviderResult(policy, name, true);
      }
      // A success is authoritative recovery evidence for quota state — it
      // outranks any parsed reset time, because the provider just served.
      routing?.quotaState?.recordSuccess(name);
      // Only an explicit model id can be attributed to a catalog entry — a
      // request that ran on the provider's own default has no specific model.
      if (catalogStore && providerConfig.model) {
        await safely(() => catalogStore.recordResult(name, providerConfig.model, { success: true }));
      }

      // Real usage evidence from the provider itself, when it reported any.
      const usage = result.usage ?? unknownUsage("provider returned no usage block");
      recordOutcome?.({
        provider: name,
        providerModelId: providerConfig.model || attempt.registryModel || "",
        executionProfile: attempt.executionProfile ?? "default",
        success: true,
        completionLatencyMs: Date.now() - attemptStartedAt,
        responseChars: typeof result?.stdout === "string" ? result.stdout.length : null,
        usage,
        // The *real* validation outcome, not an assumption. Hardcoding `true`
        // here would have recorded a provider that returned prose to a
        // json_object request as fully JSON-compliant, inverting the one
        // quality signal PARAGON can actually measure.
        structuredOutputValid: validateResponse ? validateResponse(result?.stdout) : undefined
      });

      return {
        provider: name,
        attempt,
        result,
        usage,
        failures,
        fallbackPosition: failures.length,
        remainingPlan: plan.slice(1)
      };
    } catch (error) {
      pendingChunks.length = 0;
      lastError = error;
      const classification = classifyModelFailure(error);
      addLog({
        type: "error",
        provider: name,
        level: "warn",
        message: formatProviderError(error)
      });
      if (isLive) {
        recordProviderResult(policy, name, false);
      }

      // Quota/entitlement exhaustion is provider-wide and durable: record it
      // so this provider is excluded from *subsequent* requests until its
      // known reset, not just skipped for the rest of this one.
      let quotaRecord = null;
      if (PROVIDER_WIDE_FAILURES.has(classification)) {
        quotaRecord = routing?.quotaState?.recordQuotaFailure(name, {
          classification,
          detail: `${error.message ?? ""} ${error.stdout ?? ""} ${error.stderr ?? ""}`
        });
      }
      const failureReason = friendlyFailureReason(classification, name, { resetAt: quotaRecord?.resetAt });

      routing?.routeActivity?.recordFailed({
        provider: name,
        model: attempt.registryModel,
        reason: failureReason
      });

      if (catalogStore && providerConfig.model) {
        await safely(() =>
          catalogStore.recordResult(name, providerConfig.model, {
            success: false,
            classification
          })
        );
      }
      recordOutcome?.({
        provider: name,
        providerModelId: providerConfig.model || attempt.registryModel || "",
        executionProfile: attempt.executionProfile ?? "default",
        success: false,
        failureClassification: classification,
        completionLatencyMs: Date.now() - attemptStartedAt,
        // A failed attempt reports no usage. Deliberately not zero — the
        // telemetry store ignores null fields rather than averaging in a zero.
        usage: error.usage ?? unknownUsage("attempt failed before reporting usage")
      });

      const retriesUsed = retries.get(key) ?? 0;
      const decision = planNextAfterFailure({
        classification,
        attempt,
        remainingPlan: plan.slice(1),
        retriesUsed
      });

      failures.push({ provider: name, model: attempt.registryModel, classification, action: decision.action, failureReason });

      if (attemptRecord) {
        const hasNext = decision.action === "retry" || plan.length > 1;
        await safely(() =>
          orchestration.finishAttempt(attemptRecord.id, {
            success: false,
            timeout: classifyError(error) === "TIMEOUT",
            errorClassification: classifyError(error),
            errorDiagnostic: boundedDiagnostic(error),
            fallbackReason: decision.reason,
            followedByAnotherAttempt: hasNext
          })
        );
      }

      if (decision.action === "retry") {
        retries.set(key, retriesUsed + 1);
        addLog({ type: "fallback", provider: name, level: "info", message: decision.reason });
        continue;
      }

      // The classification decision is always recorded, even when it empties
      // the plan. Logging it only when another attempt remained meant a
      // provider-wide skip — the case most worth being able to audit — left no
      // trace at all.
      addLog({ type: "fallback", provider: name, level: "info", message: decision.reason });

      // Always removes at least the failed attempt, so the loop makes progress
      // and the same provider-model is never dispatched twice.
      plan = applyFailureToPlan(plan, { attempt, classification });

      if (plan.length) {
        addLog({
          type: "fallback",
          provider: plan[0].name,
          level: "info",
          message: `Trying ${plan[0].name}/${plan[0].registryModel} after ${name} failed`
        });
      }
    }
  }

  const detail = allProvidersFailedMessage(initialPlan, lastError);
  addLog({ type: "error", provider: initialPlan[0]?.name, level: "error", message: detail });
  const exhausted = new Error(CLIENT_ERROR_MESSAGE);
  const last = failures[failures.length - 1];
  exhausted.lastProvider = last?.provider ?? initialPlan[0]?.name ?? null;
  exhausted.lastModel = last?.model ?? null;
  exhausted.lastClassification = last?.classification ?? null;
  // Reuse the reason computed at failure time — recomputing it here loses the
  // parsed reset instant, which is the most useful part of a usage-limit
  // message.
  exhausted.friendlyReason = last?.failureReason ?? null;
  throw exhausted;
}

async function streamCompletion({ res, config, plan, prompt, started, orchestration, telemetry, planContext, routing, task }) {
  const id = `chatcmpl-${Date.now()}`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let roleSent = false;
  // Bounded counters instead of accumulating the full text — a
  // multi-hundred-KB streamed response no longer means a second full copy
  // held in memory purely for telemetry.
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
    const outcome = await runPlan(plan, prompt, { ...planContext, onChunk });
    const durationMs = Date.now() - started;
    logParagonRequest(`POST /v1/chat/completions (stream) → 200 (${durationMs}ms) via ${outcome.provider}`, {
      provider: outcome.provider
    });
    // The streaming path has its own plan execution, so the executed
    // provider-model is only known here.
    recordSuccessfulRoute({ routing, outcome, durationMs, plan });
    if (telemetry) {
      await safely(() =>
        orchestration.finishRequest(telemetry, {
          success: true,
          provider: outcome.provider,
          model: outcome.attempt.registryModel,
          fallbackPosition: outcome.fallbackPosition,
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
      paragon: { provider: outcome.provider, durationMs: Date.now() - started }
    });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    logParagonRequest(`POST /v1/chat/completions (stream) → error`, {
      level: "error",
      provider: plan[0]?.name ?? "paragon"
    });
    routing?.routeActivity?.recordRequest({
      success: false,
      provider: error.lastProvider ?? plan[0]?.name ?? null,
      model: error.lastModel ?? null,
      durationMs: Date.now() - started,
      failureReason: error.friendlyReason ?? friendlyFailureReason(error.lastClassification, error.lastProvider)
    });
    if (telemetry) {
      await safely(() =>
        orchestration.finishRequest(telemetry, {
          success: false,
          provider: plan[0]?.name ?? null,
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

function chatCompletion({ model, content, durationMs, provider, routedProvider, usage }) {
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
    // Real provider-reported usage when available. Zeros were previously
    // hardcoded here; they are now only used when the provider genuinely
    // reported nothing, and the honest `null`s are reported alongside so a
    // client can tell "no reasoning" from "not reported".
    usage: {
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.visibleOutputTokens ?? 0,
      total_tokens: usage?.totalBilledTokens ?? 0,
      ...(usage?.reasoningTokens != null
        ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
        : {}),
      paragon_usage_source: usage?.usageSource ?? "unknown",
      paragon_usage_confidence: usage?.usageConfidence ?? "none"
    }
  };
}
