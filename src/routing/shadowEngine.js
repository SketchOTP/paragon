/**
 * D-004D shadow routing engine (Phase 12).
 *
 * Assembles Phases 1-10 into a complete ranking for a request, alongside the
 * live PARAGON-D-004C1 decision. Hard rules for this directive:
 *
 *  - The shadow result NEVER changes provider selection, model selection,
 *    fallback order, or the response.
 *  - It NEVER executes a provider. Everything here is pure computation over
 *    the already-loaded catalog, telemetry and benchmark data, so shadow mode
 *    cannot double provider usage or consume quota.
 *  - It NEVER records prompts or responses — only the derived task profile
 *    and numeric components.
 *
 * Live activation is explicitly out of scope and gated behind a separate
 * directive.
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

const ECONOMY_HINTS = /haiku|mini|flash|-low\b|small/i;
const PREMIUM_HINTS = /opus|mythos|fable|-pro\b|-high\b|-max\b|ultra/i;

/**
 * Cost class is retained only as a *coarse operator-facing label* and for the
 * `maxCostClass` ceiling contract that clients already depend on. It is no
 * longer an input to quality or cost scoring — that is now the real token/
 * quota model in costModel.js. Documented here so the name-derived heuristic
 * is not mistaken for economics.
 */
function labelCostClass(providerModelId) {
  if (ECONOMY_HINTS.test(providerModelId)) return "economy";
  if (PREMIUM_HINTS.test(providerModelId)) return "premium";
  return "standard";
}

/**
 * Builds the full candidate set: one entry per catalog-eligible
 * provider-model, with its execution profile, capability profile, context
 * model, benchmark resolution and telemetry attached.
 */
export function buildShadowCandidates({
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

      // D-004C1 chat-capability gate preserved as a pre-filter.
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
        telemetry
      });
    }
  }

  return { candidates, benchmarkCoverage: benchmarkCoverageReport(benchmarkResolutions), rejectedAliases };
}

/**
 * Computes the complete shadow decision for a request. Pure — no provider
 * calls, no writes.
 */
export function computeShadowRoute({
  config,
  statuses = {},
  catalog,
  telemetryStore,
  benchmarkRows = [],
  taskProfile,
  hints = {},
  settings = {}
}) {
  const { candidates, benchmarkCoverage, rejectedAliases } = buildShadowCandidates({
    config,
    statuses,
    catalog,
    telemetryStore,
    benchmarkRows,
    taskProfile,
    settings
  });

  const result = rankCandidates(candidates, {
    taskProfile,
    taskRoutes: config?.routing?.taskRoutes ?? {},
    minimumSamplesForMeasuredEstimate: settings.minimumSamplesForMeasuredEstimate ?? 10,
    unknownLargeContextThresholdTokens: settings.unknownLargeContextThresholdTokens ?? 50000,
    maxCostClass: hints?.maxCostClass ?? null,
    quotaScarcity: settings.quotaScarcity ?? 0,
    explicitlyForced: Boolean(hints?.forceProvider)
  });

  const attemptPlan = buildAttemptPlan(result.ranked, config, {
    maximumAttempts: settings.maximumAttempts ?? 4
  });

  return {
    ...result,
    attemptPlan: summarizeAttemptPlan(attemptPlan),
    benchmarkCoverage,
    rejectedAliases,
    candidateCount: candidates.length,
    eligibleCount: result.ranked.filter((c) => !c.excluded).length
  };
}

/**
 * Bounded shadow record. Contains no prompt, no response, and no credential —
 * only the derived profile and numeric decision components.
 */
export function buildShadowRecord({ taskProfile, shadow, liveProvider, liveModel, now = new Date().toISOString() }) {
  const winner = shadow?.winner ?? null;
  const agrees = Boolean(winner && winner.provider === liveProvider && winner.providerModelId === liveModel);
  return {
    at: now,
    taskProfile: {
      workType: taskProfile.workType,
      complexity: taskProfile.complexity,
      risk: taskProfile.risk,
      reasoningDemand: taskProfile.reasoningDemand,
      contextBand: taskProfile.contextBand,
      outputContract: taskProfile.outputContract,
      latencyPreference: taskProfile.latencyPreference,
      qualityPreference: taskProfile.qualityPreference,
      costSensitivity: taskProfile.costSensitivity,
      estimatedInputTokens: taskProfile.estimatedInputTokens,
      requiredCapabilities: taskProfile.requiredCapabilities
    },
    live: { provider: liveProvider ?? null, model: liveModel ?? null },
    shadow: winner
      ? {
          provider: winner.provider,
          providerModelId: winner.providerModelId,
          canonicalModelId: winner.canonicalModelId,
          reasoningEffort: winner.reasoningEffort,
          speedMode: winner.speedMode,
          expectedUtility: winner.expectedUtility,
          components: winner.components,
          expectedReasoningTokens: winner.cost?.expectedReasoningTokens ?? null,
          expectedReasoningTokenRange: winner.cost?.expectedReasoningTokenRange ?? null,
          estimatedMonetaryCost: winner.cost?.estimatedMonetaryCost ?? null,
          estimatedQuotaBurn: winner.cost?.estimatedQuotaBurn ?? null,
          estimatedTotalResourceCost: winner.cost?.estimatedTotalResourceCost ?? null,
          benchmark: winner.benchmark,
          measuredEvidenceShare: winner.measuredEvidenceShare
        }
      : null,
    confidence: shadow?.confidence ?? null,
    agrees,
    disagrees: Boolean(winner) && !agrees,
    eligibleCount: shadow?.eligibleCount ?? 0,
    attemptPlan: shadow?.attemptPlan ?? []
  };
}
