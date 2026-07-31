/**
 * PARAGON automatic routing — the sole live routing engine (PARAGON-D-004E).
 *
 * This module is the production successor to two things that used to coexist:
 * the additive label scorer that actually decided routes, and the
 * expected-utility engine that ran alongside it in shadow and decided nothing.
 * There is now exactly one engine, it runs exactly once per request, and its
 * output is what executes.
 *
 * Execution order is fixed and, deliberately, not rearrangeable by
 * configuration:
 *
 *   1. build the request profile                (taskProfile.js)
 *   2. build the current eligible registry      (buildRoutingCandidates below)
 *   3. apply hard gates                         (expectedUtility.checkHardEligibility)
 *        capability, context, health, circuit, cost ceiling, quota, catalog
 *   4. calculate expected utility               (expectedUtility.scoreCandidate)
 *   5. apply explicit tie-breakers              (expectedUtility.compareCandidates)
 *   6. build the bounded attempt plan           (attemptPlan.buildAttemptPlan)
 *   7. verify every attempt against the registry(verifyPlanAgainstCandidates)
 *   8. execute                                  (openaiApi.js)
 *   9. record actual outcomes                   (openaiApi.js -> outcomeTelemetry)
 *
 * Steps 3 and 4 stay strictly separated: scoring never rescues an inadmissible
 * candidate. That separation is the routing-integrity guarantee inherited from
 * D-004C1 and every gate it enforced is preserved here.
 */

import { listCatalogEntries } from "../modelCatalog.js";
import { parseExecutionProfile } from "./executionProfile.js";
import { buildCapabilityProfile } from "./capabilityProfile.js";
import { buildContextModel } from "./contextModel.js";
import { buildAliasIndex, resolveBenchmark, benchmarkCoverageReport } from "./benchmarkCanonical.js";
import { readTelemetry } from "./outcomeTelemetry.js";
import { rankCandidates } from "./expectedUtility.js";
import { buildAttemptPlan, summarizeAttemptPlan } from "./attemptPlan.js";
import { classifyChatCapability } from "../modelCapability.js";
import { resolveUtilityWeights, normalizeRoutingPriority } from "./routingPriority.js";
import { executionMethodFor, expertTupleId } from "./expertTuple.js";
import { publishedModelPricing } from "./modelPricing.js";
import { optimizeFallbackPlan, evaluatePlan } from "./planOptimizer.js";

const ECONOMY_HINTS = /haiku|mini|flash|-low\b|small/i;
const PREMIUM_HINTS = /opus|mythos|fable|-pro\b|-high\b|-max\b|ultra/i;

/**
 * Cost class is retained only as a *coarse operator-facing label* and for the
 * `maxCostClass` ceiling contract that clients already depend on. It is not an
 * input to quality or cost scoring — that is the real token/quota model in
 * costModel.js. Documented so the name-derived heuristic is never mistaken for
 * economics.
 */
function labelCostClass(providerModelId) {
  if (ECONOMY_HINTS.test(providerModelId)) return "economy";
  if (PREMIUM_HINTS.test(providerModelId)) return "premium";
  return "standard";
}

/**
 * Builds the candidate set: one entry per catalog-eligible provider-model,
 * with its execution profile, capability profile, context model, benchmark
 * resolution and outcome telemetry attached.
 *
 * Pure over already-loaded state — no provider calls, no I/O. An unassessed
 * provider contributes a single `pendingAssessment` marker and nothing
 * routable, so enabling a provider never makes it trusted.
 */
export function buildRoutingCandidates({
  config,
  statuses = {},
  catalog,
  telemetryStore = { entries: {} },
  benchmarkRows = [],
  taskProfile,
  settings = {}
}) {
  const ttlHours = config?.modelCatalog?.validationTtlHours ?? 24;
  const minimumSamples = settings.minimumSamplesForMeasuredEstimate ?? 10;
  const { index: aliasIndex, rejected: rejectedAliases } = buildAliasIndex(settings.canonicalAliasMappings ?? []);
  const reasoningProfileMappings = settings.reasoningProfileMappings ?? {};

  const candidates = [];
  const benchmarkResolutions = [];

  for (const [provider, providerConfig] of Object.entries(config?.providers ?? {})) {
    if (!providerConfig.enabled) {
      continue;
    }
    const health = statuses[provider]?.ok === true ? "healthy" : statuses[provider] ? "unhealthy" : "unknown";
    const assessed = Boolean(catalog?.providers && Object.prototype.hasOwnProperty.call(catalog.providers, provider));
    const isHttpProvider = providerConfig.type === "http";

    if (!assessed) {
      candidates.push({
        provider,
        providerModelId: null,
        pendingAssessment: true,
        catalogEligible: false,
        health,
        isHttpProvider
      });
      continue;
    }

    const entries = listCatalogEntries(catalog, provider, { ttlHours }).filter((entry) => entry.automaticEligibility);

    for (const entry of entries) {
      const providerModelId = entry.modelId;
      if (!providerModelId) continue;

      // Chat-capability gate, preserved as a pre-filter: a model positively
      // identified as non-chat can never enter chat routing.
      if (classifyChatCapability({ modelId: providerModelId, metadata: entry.metadata }) === "unsupported") {
        continue;
      }

      const executionProfile = parseExecutionProfile(provider, providerModelId, { explicitMappings: reasoningProfileMappings });

      const capabilities = buildCapabilityProfile({
        provider,
        providerModelId,
        catalogEntry: entry,
        executionProfile,
        operatorMapping: settings.capabilityMappings?.[`${provider}/${providerModelId}`] ?? null,
        isHttpProvider
      });
      const reasoningProfile = executionProfile.reasoningEffort ?? "unknown";
      const executionMethod = executionMethodFor(provider, isHttpProvider);
      const executionPath = isHttpProvider ? "openai-compatible-http" : "native-agent-cli";

      const telemetrySelector = {
        provider,
        providerModelId,
        executionProfile: executionProfile.executionProfile,
        workType: taskProfile?.workType,
        complexity: taskProfile?.complexity,
        contextBand: taskProfile?.contextBand,
        outputContract: taskProfile?.outputContract
      };
      const telemetry = readTelemetry(telemetryStore, telemetrySelector, { minimumSamplesForMeasuredEstimate: minimumSamples });

      const contextModel = buildContextModel({
        provider,
        canonicalModelId: executionProfile.canonicalModelId,
        catalogEntry: entry,
        telemetry,
        operatorConfig: settings.contextOverrides?.[`${provider}/${providerModelId}`] ?? null
      });

      const benchmark = resolveBenchmark({
        providerModelId,
        canonicalModelId: executionProfile.canonicalModelId,
        benchmarkRows,
        aliasIndex
      });
      benchmarkResolutions.push(benchmark);
      const publishedPricing = publishedModelPricing({
        provider,
        modelId: executionProfile.canonicalModelId,
        benchmarkPricing: benchmark.row?.pricing ?? null,
        metadata: entry.metadata
      });
      if (!publishedPricing && config?.automaticRouting?.requirePublishedPricing === true && settings.requirePublishedPricing !== false) continue;

      candidates.push({
        provider,
        providerModelId,
        pendingAssessment: false,
        catalogEligible: true,
        health,
        isHttpProvider,
        costClass: labelCostClass(providerModelId),
        modelState: entry.state,
        executionProfile,
        capabilities,
        contextModel,
        benchmark: benchmark.row ? benchmark : null,
        publishedPricing,
        telemetry,
        reasoningProfile,
        executionMethod,
        executionPath,
        expertId: expertTupleId({ provider, canonicalModelId: executionProfile.canonicalModelId, reasoningProfile, executionMethod })
      });
    }
  }

  return { candidates, benchmarkCoverage: benchmarkCoverageReport(benchmarkResolutions), rejectedAliases };
}

/** A forced route that failed a gate — surfaced as a bounded 400, never silently downgraded to automatic routing. */
function rejection(reasonCode, message) {
  return { rejected: true, reasonCode, message, ranked: [], attemptPlan: [], attemptPlanSummary: [] };
}

/**
 * The live per-request routing decision.
 *
 * @returns {{
 *   winner: object|null, ranked: object[], confidence: object,
 *   attemptPlan: object[], attemptPlanSummary: object[],
 *   rejected?: boolean, reasonCode?: string, message?: string
 * }}
 */
export function selectAutomaticRoute({
  config,
  statuses = {},
  catalog,
  telemetryStore,
  benchmarkRows = [],
  taskProfile,
  hints = {},
  settings = {},
  quotaState = null,
  priority = null
}) {
  const resolvedPriority = normalizeRoutingPriority(priority ?? config?.routing?.priority);
  const weights = resolveUtilityWeights(resolvedPriority);

  const { candidates, benchmarkCoverage, rejectedAliases } = buildRoutingCandidates({
    config,
    statuses,
    catalog,
    telemetryStore,
    benchmarkRows,
    taskProfile,
    settings
  });

  // A forced route may only ever *narrow* the candidate set. It is resolved
  // against the eligible candidates — never against config — so no `/v1`
  // client can name a rejected or nonexistent model and have it dispatched.
  let considered = candidates;
  if (hints.forceProvider) {
    const providerConfig = config?.providers?.[hints.forceProvider];
    if (!providerConfig?.enabled) {
      return rejection("routing.forcedProviderNotEligible", `Provider "${hints.forceProvider}" is not enabled.`);
    }
    const providerCandidates = candidates.filter((c) => c.provider === hints.forceProvider);
    if (providerCandidates.some((c) => c.pendingAssessment)) {
      return rejection(
        "routing.providerPendingAssessment",
        `Provider "${hints.forceProvider}" has not completed model-catalog assessment yet.`
      );
    }
    const routable = providerCandidates.filter((c) => c.providerModelId);
    if (!routable.length) {
      return hints.forceModel
        ? rejection(
            "routing.forcedModelNotEligible",
            `Model "${hints.forceModel}" is not currently exposed or validated for provider "${hints.forceProvider}".`
          )
        : rejection("routing.forcedProviderNotEligible", `Provider "${hints.forceProvider}" has no catalog-eligible models.`);
    }
    considered = routable;
    if (hints.forceModel) {
      considered = routable.filter((c) => c.providerModelId === hints.forceModel);
      if (!considered.length) {
        return rejection(
          "routing.forcedModelNotEligible",
          `Model "${hints.forceModel}" is not currently exposed or validated for provider "${hints.forceProvider}".`
        );
      }
    }
  }

  const result = rankCandidates(considered, {
    taskProfile,
    weights,
    minimumSamplesForMeasuredEstimate: settings.minimumSamplesForMeasuredEstimate ?? 10,
    unknownLargeContextThresholdTokens: settings.unknownLargeContextThresholdTokens ?? 50000,
    maxCostClass: hints?.maxCostClass ?? null,
    quotaScarcity: quotaState?.scarcity ? quotaState.scarcity(config) : (settings.quotaScarcity ?? 0),
    providerPreferencePoints: settings.providerPreferencePoints ?? config?.automaticRouting?.providerPreferencePoints ?? {},
    providerPreferenceScale: settings.providerPreferenceScale ?? config?.automaticRouting?.providerPreferenceScale ?? 3,
    quotaState,
    explicitlyForced: Boolean(hints?.forceProvider)
  });

  // A forced route whose only candidates failed a hard gate is a client
  // error, not a downgrade to automatic routing.
  if (hints.forceProvider && !result.winner) {
    const why = result.ranked[0]?.reasonCode ?? "eligibility.unknown";
    return rejection(
      hints.forceModel ? "routing.forcedModelNotEligible" : "routing.forcedProviderNotEligible",
      `Forced route for "${hints.forceProvider}" failed an eligibility gate (${why}).`
    );
  }

  const optimization = optimizeFallbackPlan(result.ranked.filter((c) => !c.excluded), {
    maximumAttempts: settings.maximumAttempts ?? 4,
    minimumAttempts: Math.min(2, settings.maximumAttempts ?? 4),
    successTarget: taskProfile?.sufficiencyThreshold,
    failureProbability: (candidate) => 1 - Number(candidate.components?.confidenceAdjustedSuccessProbability ?? candidate.components?.probabilityOfSuccessfulCompletion ?? 0.85),
    attemptCost: (candidate) => Number(candidate.components?.expectedCostPerSuccessfulTask ?? candidate.components?.expectedTotalResourceCost ?? 0),
    providerFailureProbability: (candidate) => candidate.components?.providerFailureProbability ?? 0
  });
  const optimizedRanked = optimization?.plan?.length ? optimization.plan : result.ranked;
  const attemptPlan = buildAttemptPlan(optimizedRanked, config, { maximumAttempts: settings.maximumAttempts ?? 4 });

  return {
    ...result,
    priority: resolvedPriority,
    reasonCode: hints.forceProvider ? "hint.forceProvider" : "automatic.expectedUtility",
    attemptPlan,
    attemptPlanSummary: summarizeAttemptPlan(attemptPlan),
    planOptimization: optimization ? { ...optimization.score, route: optimization.route ?? result.routeStatus } : null,
    benchmarkCoverage,
    rejectedAliases,
    candidateCount: candidates.length,
    eligibleCount: result.ranked.filter((c) => !c.excluded).length
  };
}

/**
 * Immediately-before-dispatch integrity assertion: re-derives every planned
 * attempt against the candidate set that produced it, so a plan can never
 * carry a row that is not presently eligible. Returns the offending attempts
 * rather than throwing, so the caller can fail the request with a bounded
 * error instead of dispatching something unverified.
 */
export function verifyPlanAgainstCandidates(plan, ranked, config) {
  const eligible = new Map();
  for (const candidate of ranked) {
    if (!candidate.excluded && candidate.providerModelId) {
      eligible.set(`${candidate.provider}/${candidate.providerModelId}`, candidate);
    }
  }

  const violations = [];
  for (const attempt of plan) {
    const providerConfig = config?.providers?.[attempt.name];
    if (!providerConfig?.enabled) {
      violations.push({ attempt: attempt.name, model: attempt.registryModel, reason: "provider not enabled" });
      continue;
    }
    const candidate = eligible.get(`${attempt.name}/${attempt.registryModel}`);
    if (!candidate) {
      violations.push({
        attempt: attempt.name,
        model: attempt.registryModel,
        reason: "not a currently eligible registry entry"
      });
      continue;
    }
    if (candidate.capabilities && candidate.capabilities.chatCompletions === false) {
      violations.push({ attempt: attempt.name, model: attempt.registryModel, reason: "does not support chat completions" });
    }
  }
  return violations;
}
