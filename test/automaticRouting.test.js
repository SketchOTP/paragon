/**
 * Automatic-routing unit coverage.
 *
 * Each test names the design rule it pins. The central rule under test is:
 *
 *   model identity  ≠  reasoning profile  ≠  speed profile
 *
 * This suite covers the one production routing engine. It carried over from
 * the engine's shadow-mode era (PARAGON-D-004D) unchanged in substance —
 * every invariant here is now an invariant of the *live* selector.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseExecutionProfile, reasoningEffortRank, providerGrammarSummary, hasProviderGrammar } from "../src/routing/executionProfile.js";
import { estimateReasoningTokens, estimateEffectiveCost, reasoningFit } from "../src/routing/costModel.js";
import { buildCapabilityProfile, checkRequiredCapabilities } from "../src/routing/capabilityProfile.js";
import { buildContextModel, checkContextFit } from "../src/routing/contextModel.js";
import { buildTaskProfile } from "../src/routing/taskProfile.js";
import { resolveBenchmark, buildAliasIndex, normalizeAliasRecord } from "../src/routing/benchmarkCanonical.js";
import { defaultTelemetryStore, recordOutcome, readTelemetry, pruneTelemetry, telemetryKey } from "../src/routing/outcomeTelemetry.js";
import { rankCandidates, compareCandidates, routingConfidence, UTILITY_WEIGHTS } from "../src/routing/expectedUtility.js";
import { buildAttemptPlan, planNextAfterFailure, applyFailureToPlan } from "../src/routing/attemptPlan.js";
import { selectAutomaticRoute, verifyPlanAgainstCandidates } from "../src/routing/automaticRouting.js";
import { createRouteActivityStore } from "../src/routing/routeActivity.js";
import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";
import { resetForTests } from "../src/orchestration/liveEnforcement.js";
import { publishedModelPricing } from "../src/routing/modelPricing.js";

test.beforeEach(() => {
  resetForTests();
});

test("published pricing uses the current Codex Luna rate and never labels it subscription", () => {
  const price = publishedModelPricing({ provider: "codex", modelId: "gpt-5.6-luna" });
  assert.equal(price.inputPerMillion, 5);
  assert.equal(price.completionPerMillion, 30);
  assert.equal(price.cacheReadPerMillion, 0.5);
  assert.equal(price.billingUnit, "Codex credits per 1M tokens");
  assert.equal(price.asOf, "2026-07-30");
  assert.equal(price.apiPricing.inputPerMillion, 0.2);
  assert.equal(price.apiPricing.completionPerMillion, 1.2);
  assert.equal(price.apiPricing.sourceUrl, "https://developers.openai.com/api/docs/models/compare");
});

test("task context demand reflects the work being ranked", () => {
  const code = buildTaskProfile({ prompt: "implement a feature in the repository", estimatedInputTokens: 4000 });
  const quick = buildTaskProfile({ prompt: "quick answer: what is two plus two?", estimatedInputTokens: 4000 });
  assert.equal(code.estimatedRequiredContextTokens, 150000);
  assert.equal(quick.estimatedRequiredContextTokens, 4000);
  const demands = [
    ["explain this concept", "explain", 16000],
    ["write documentation for this API", "documentation", 32000],
    ["plan the implementation roadmap", "planning", 64000],
    ["review this pull request diff", "review", 100000],
    ["debug this production error", "debug", 172500],
    ["design the system architecture", "architecture", 250000]
  ];
  for (const [prompt, workType, expectedDemand] of demands) {
    const profile = buildTaskProfile({ prompt, estimatedInputTokens: 4000 });
    assert.equal(profile.workType, workType);
    assert.equal(profile.estimatedRequiredContextTokens, expectedDemand);
  }
});

test("context capacity changes eligibility and rank according to task demand", () => {
  const code = buildTaskProfile({ prompt: "implement a feature in the repository", estimatedInputTokens: 4000 });
  const candidate = (providerModelId, contextWindow) => ({
    provider: "codex",
    providerModelId,
    catalogEligible: true,
    health: "healthy",
    executionProfile: parseExecutionProfile("codex", providerModelId),
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true },
    contextModel: { effectiveUsableContextWindow: contextWindow, contextConfidence: "high", outputTokenReserve: 4096 },
    publishedPricing: publishedModelPricing({ provider: "codex", modelId: providerModelId })
  });
  const result = rankCandidates([candidate("gpt-5.4", 120000), candidate("gpt-5.6-terra", 400000)], {
    taskProfile: code,
    unknownLargeContextThresholdTokens: 50000
  });
  assert.equal(result.ranked.find((row) => row.providerModelId === "gpt-5.4").excluded, true);
  assert.equal(result.winner.providerModelId, "gpt-5.6-terra");
  assert.equal(result.winner.components.contextRequirementTokens, 150000);
  assert.ok(result.winner.components.contextFitTerm > 0);
});

test("unknown context capacity is not eligible for a high-context code task", () => {
  const code = buildTaskProfile({ prompt: "implement a feature", estimatedInputTokens: 4000 });
  const result = rankCandidates([{
    provider: "openrouter",
    providerModelId: "unknown-context-model",
    catalogEligible: true,
    health: "healthy",
    isHttpProvider: true,
    executionProfile: parseExecutionProfile("openrouter", "unknown-context-model"),
    capabilities: { chatCompletions: true },
    contextModel: { effectiveUsableContextWindow: null, contextConfidence: "none", outputTokenReserve: 4096 }
  }], { taskProfile: code, unknownLargeContextThresholdTokens: 50000 });
  assert.equal(result.ranked[0].reasonCode, "routing.unknownContextForLargeRequest");
});

test("provider preference points are configurable, scaled, and additive", () => {
  const candidate = (provider) => ({
    provider,
    providerModelId: `${provider}-model`,
    catalogEligible: true,
    health: "healthy",
    isHttpProvider: provider === "openrouter",
    executionProfile: parseExecutionProfile(provider, provider === "codex" ? "gpt-5.6-luna" : "claude-sonnet-5"),
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true },
    contextModel: { effectiveUsableContextWindow: 200000, contextConfidence: "high", outputTokenReserve: 4096 },
    telemetry: null,
    benchmark: null,
    publishedPricing: { inputPerMillion: 1, completionPerMillion: 6, billingUnit: "USD per 1M tokens" }
  });
  const taskProfile = buildTaskProfile({ prompt: "write code", estimatedInputTokens: 100 });
  const result = rankCandidates([candidate("claude"), candidate("codex")], {
    taskProfile,
    unknownLargeContextThresholdTokens: 50000,
    providerPreferencePoints: { claude: 2, codex: 3 },
    providerPreferenceScale: 3
  });
  assert.equal(result.winner.provider, "codex");
  assert.equal(result.winner.components.providerPreferenceTerm, 9);
  assert.equal(result.winner.components.providerPreferenceBonus, 9);
  assert.equal(
    result.winner.expectedUtility,
    result.winner.components.utilityBeforePreference + result.winner.components.providerPreferenceTerm
  );
  assert.equal(result.ranked.find((row) => row.provider === "claude").components.providerPreferenceTerm, 6);
});

test("benchmark pricing never crosses provider identity", () => {
  const benchmarkPricing = { prompt: 0.000001, completion: 0.000006 };
  assert.equal(publishedModelPricing({ provider: "codex", modelId: "gpt-5.1-codex-mini", benchmarkPricing }), null);
  assert.equal(publishedModelPricing({ provider: "claude", modelId: "unknown-model", benchmarkPricing }), null);
  assert.equal(publishedModelPricing({ provider: "openrouter", modelId: "openai/gpt-5.6-luna", benchmarkPricing }).source, "OpenRouter benchmark pricing");
});

test("Codex credits are estimated separately from monetary cost", () => {
  const cost = estimateEffectiveCost({
    provider: "codex",
    isHttpProvider: false,
    executionProfile: { reasoningEffort: "low", speedMode: "standard" },
    taskProfile: { workType: "code", complexity: "normal" },
    publishedPricing: publishedModelPricing({ provider: "codex", modelId: "gpt-5.6-luna" }),
    benchmarkPricing: { prompt: 0.000001, completion: 0.000006 },
    estimatedInputTokens: 1000
  });
  assert.ok(cost.estimatedCreditsConsumed > 0);
  assert.equal(cost.estimatedMonetaryCost, null);
  assert.equal(cost.pricingSource, "OpenAI Codex rate card");
});

test("scored candidates preserve official API pricing provenance", () => {
  const price = publishedModelPricing({ provider: "codex", modelId: "gpt-5.6-terra" });
  const candidate = {
    provider: "codex",
    providerModelId: "gpt-5.6-terra",
    catalogEligible: true,
    health: "healthy",
    executionProfile: parseExecutionProfile("codex", "gpt-5.6-terra"),
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true },
    contextModel: { effectiveUsableContextWindow: 200000, contextConfidence: "high", outputTokenReserve: 4096 },
    publishedPricing: price
  };
  const result = rankCandidates([candidate], { taskProfile: buildTaskProfile({ prompt: "write code", estimatedInputTokens: 100 }) });
  assert.equal(result.ranked[0].publishedPricing.apiPricing.inputPerMillion, 2);
});

// ---------------------------------------------------------------- Phase 1

test("1. provider-specific reasoning suffix parsing separates identity from effort", () => {
  const r = parseExecutionProfile("cursor", "gpt-5.6-terra-max");
  assert.equal(r.providerModelId, "gpt-5.6-terra-max");
  assert.equal(r.canonicalModelId, "gpt-5.6-terra");
  assert.equal(r.reasoningEffort, "max");
  assert.equal(r.speedMode, "standard");
});

test("2. combined low-fast profile parses both dimensions", () => {
  const r = parseExecutionProfile("cursor", "gpt-5.6-terra-low-fast");
  assert.equal(r.canonicalModelId, "gpt-5.6-terra");
  assert.equal(r.reasoningEffort, "low");
  assert.equal(r.speedMode, "fast");
  assert.equal(r.executionProfile, "effort:low|speed:fast");
});

test("2b. cursor's `thinking` marker is a model variant, not an effort (both forms exist upstream)", () => {
  const plain = parseExecutionProfile("cursor", "claude-opus-5-high");
  const thinking = parseExecutionProfile("cursor", "claude-opus-5-thinking-high");
  assert.equal(plain.canonicalModelId, "claude-opus-5");
  assert.equal(thinking.canonicalModelId, "claude-opus-5");
  assert.equal(thinking.modelVariant, "thinking");
  assert.equal(plain.modelVariant, null);
  assert.notEqual(plain.executionProfile, thinking.executionProfile);
});

test("3. an unknown suffix stays part of the canonical model id", () => {
  const r = parseExecutionProfile("cursor", "composer-2.5");
  assert.equal(r.canonicalModelId, "composer-2.5");
  assert.equal(r.reasoningEffort, "unknown");
});

// The exact asymmetry the directive warns about, verified against real
// production ids: `max` is an effort modifier for cursor and part of the
// model identity for codex.
test("4. no generic stripping of max/high/low/fast — a provider without a declared grammar keeps its whole id", () => {
  const codexMax = parseExecutionProfile("codex", "gpt-5.1-codex-max");
  assert.equal(codexMax.canonicalModelId, "gpt-5.1-codex-max", "codex `max` is model identity and must survive");
  assert.equal(codexMax.reasoningEffort, "unknown");
  assert.equal(codexMax.profileParseSource, "no_provider_grammar");

  const cursorMax = parseExecutionProfile("cursor", "gpt-5.6-sol-max");
  assert.equal(cursorMax.canonicalModelId, "gpt-5.6-sol", "cursor `max` is an effort modifier");
  assert.equal(cursorMax.reasoningEffort, "max");

  // antigravity: `flash`/`pro` are Google model identity, `high` is effort.
  const agy = parseExecutionProfile("antigravity", "gemini-3.6-flash-high");
  assert.equal(agy.canonicalModelId, "gemini-3.6-flash");
  assert.equal(agy.reasoningEffort, "high");

  // claude has no effort encoding at all.
  assert.equal(parseExecutionProfile("claude", "claude-opus-4-8").canonicalModelId, "claude-opus-4-8");
  assert.equal(hasProviderGrammar("claude"), false);
  assert.equal(hasProviderGrammar("codex"), false);
  assert.ok(providerGrammarSummary().cursor.effortTokens.includes("max"));
});

test("4b. an operator-reviewed explicit mapping overrides grammar inference", () => {
  const r = parseExecutionProfile("codex", "gpt-5.1-codex-max", {
    explicitMappings: { "codex/gpt-5.1-codex-max": { canonicalModelId: "gpt-5.1-codex", reasoningEffort: "max", speedMode: "standard" } }
  });
  assert.equal(r.canonicalModelId, "gpt-5.1-codex");
  assert.equal(r.reasoningEffort, "max");
  assert.equal(r.profileParseSource, "explicit_mapping");
});

// ---------------------------------------------------------------- Phase 7

test("5. canonical benchmark match preserves the execution profile and is labeled as base-model evidence", () => {
  const rows = [{ model_permaslug: "openai/gpt-5.6-terra", display_name: "GPT-5.6 Terra", coding_index: 70, pricing: { prompt: "0.000002" } }];
  const resolved = resolveBenchmark({ providerModelId: "gpt-5.6-terra-max", canonicalModelId: "gpt-5.6-terra", benchmarkRows: rows });
  assert.equal(resolved.matchMethod, "canonical_model");
  assert.equal(resolved.appliesToCanonicalModel, "gpt-5.6-terra");
  assert.match(resolved.note, /canonical base model/);
  // Substring guessing stays gone: a decorated id must not match directly.
  assert.equal(resolveBenchmark({ providerModelId: "gpt-5.6-terra-max", canonicalModelId: "gpt-5.6-terra-max", benchmarkRows: rows }).matchMethod, "none");
});

test("5b. an alias record without provenance is rejected rather than silently trusted", () => {
  assert.equal(normalizeAliasRecord({ providerModelId: "a", canonicalModelId: "b" }).ok, false);
  const good = normalizeAliasRecord({
    providerModelId: "a",
    canonicalModelId: "b",
    benchmarkModelId: "vendor/b",
    rationale: "same weights, different label",
    reviewedAt: "2026-07-29",
    source: "operator"
  });
  assert.equal(good.ok, true);
  const { index, rejected } = buildAliasIndex([{ providerModelId: "x" }, good.record]);
  assert.equal(rejected.length, 1);
  assert.equal(index.size, 1);
});

// ---------------------------------------------------------------- Phase 2

test("6. reasoning effort increases expected token consumption monotonically", () => {
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  let previous = -1;
  for (const effort of order) {
    const { expectedReasoningTokens } = estimateReasoningTokens({ reasoningEffort: effort, expectedVisibleOutputTokens: 1000 });
    assert.ok(expectedReasoningTokens >= previous, `${effort} must not expect fewer reasoning tokens than the previous level`);
    previous = expectedReasoningTokens;
  }
  assert.ok(reasoningEffortRank("max") > reasoningEffortRank("low"));
  assert.equal(reasoningEffortRank("unknown"), null);
});

test("6b. reasoning effort increases priced token consumption monotonically", () => {
  const costFor = (reasoningEffort) =>
    estimateEffectiveCost({
      provider: "cursor",
      executionProfile: { reasoningEffort, speedMode: "standard" },
      taskProfile: { workType: "code", complexity: "normal", requestedMaxOutputTokens: 1000 },
      estimatedInputTokens: 1000
    });
  const low = costFor("low");
  const max = costFor("max");
  assert.ok(max.estimatedTotalResourceCost > low.estimatedTotalResourceCost, "a max profile must consume more priced resources than low");
  assert.ok(max.effectiveExpectedTokens > low.effectiveExpectedTokens);
  assert.equal(low.isSubscriptionProvider, true);
});

test("7. a max-reasoning candidate loses a trivial task on resource cost", () => {
  const shared = {
    provider: "cursor",
    catalogEligible: true,
    health: "healthy",
    isHttpProvider: false,
    costClass: "standard",
    capabilities: { chatCompletions: true, streaming: true, capabilityConfidence: "high" },
    contextModel: { effectiveUsableContextWindow: 200000, contextConfidence: "high", outputTokenReserve: 4096 },
    benchmark: null,
    telemetry: null
  };
  const taskProfile = buildTaskProfile({ prompt: "fix this typo", estimatedInputTokens: 500 });
  assert.equal(taskProfile.complexity, "trivial");
  assert.equal(taskProfile.reasoningDemand, "minimal");

  const { winner, ranked } = rankCandidates(
    [
      { ...shared, providerModelId: "m-max", executionProfile: parseExecutionProfile("cursor", "m-max") },
      { ...shared, providerModelId: "m-low", executionProfile: parseExecutionProfile("cursor", "m-low") }
    ],
    { taskProfile, unknownLargeContextThresholdTokens: 50000 }
  );
  assert.equal(winner.reasoningEffort, "low", "over-reasoning a trivial task must lose");
  const maxCandidate = ranked.find((c) => c.reasoningEffort === "max");
  assert.ok(maxCandidate.components.expectedTotalResourceCost > winner.components.expectedTotalResourceCost);
  assert.ok(maxCandidate.components.reasoningFitAlignment < 0);
});

test("8. a max-reasoning candidate can win a high-risk complex task when quality justifies the cost", () => {
  const shared = {
    provider: "cursor",
    catalogEligible: true,
    health: "healthy",
    isHttpProvider: false,
    costClass: "standard",
    capabilities: { chatCompletions: true, streaming: true, capabilityConfidence: "high" },
    contextModel: { effectiveUsableContextWindow: 400000, contextConfidence: "high", outputTokenReserve: 4096 },
    telemetry: null
  };
  const taskProfile = buildTaskProfile({
    prompt: "audit this authentication bypass vulnerability across the whole system and prove every edge case",
    estimatedInputTokens: 2000
  });
  assert.equal(taskProfile.risk, "security_critical");
  assert.equal(taskProfile.reasoningDemand, "maximum");

  const { winner } = rankCandidates(
    [
      { ...shared, providerModelId: "m-max", executionProfile: parseExecutionProfile("cursor", "m-max") },
      { ...shared, providerModelId: "m-low", executionProfile: parseExecutionProfile("cursor", "m-low") }
    ],
    { taskProfile, unknownLargeContextThresholdTokens: 50000 }
  );
  assert.equal(winner.reasoningEffort, "max", "a maximum-reasoning-demand task must be able to justify max effort");
});

test("9. provider-returned/measured reasoning tokens override the ordinal prior", () => {
  const telemetry = { observedReasoningTokens: 42, sampleCount: 50 };
  const measured = estimateReasoningTokens({ reasoningEffort: "max", expectedVisibleOutputTokens: 1000, telemetry });
  assert.equal(measured.reasoningEstimateSource, "measured_history");
  assert.equal(measured.expectedReasoningTokens, 42, "measurement must beat the prior even when the prior is much larger");
  const prior = estimateReasoningTokens({ reasoningEffort: "max", expectedVisibleOutputTokens: 1000 });
  assert.equal(prior.reasoningEstimateSource, "ordinal_prior");
  assert.ok(prior.expectedReasoningTokens > 42);
});

test("10. unknown reasoning burn receives an uncertainty penalty and is not assumed to be zero", () => {
  const unknown = estimateReasoningTokens({ reasoningEffort: "unknown", expectedVisibleOutputTokens: 1000 });
  assert.equal(unknown.expectedReasoningTokens, null, "unknown must not silently become 0");
  assert.equal(unknown.reasoningBurnClass, "unknown");

  const cost = estimateEffectiveCost({
    provider: "codex",
    executionProfile: { reasoningEffort: "unknown", speedMode: "unknown" },
    taskProfile: { workType: "code", complexity: "normal" },
    estimatedInputTokens: 1000
  });
  assert.ok(cost.costUncertainty >= 0.5);
});

test("11. published model costs are reported and never treated as free", () => {
  const subscription = estimateEffectiveCost({
    provider: "claude",
    isHttpProvider: false,
    executionProfile: { reasoningEffort: "medium", speedMode: "standard" },
    taskProfile: { workType: "code", complexity: "normal" },
    estimatedInputTokens: 5000
  });
  assert.equal(subscription.isSubscriptionProvider, true);
  assert.ok(subscription.estimatedTotalResourceCost > 0, "a priced call must never cost zero resources");

  const http = estimateEffectiveCost({
    provider: "lmstudio",
    isHttpProvider: true,
    executionProfile: { reasoningEffort: "medium", speedMode: "standard" },
    taskProfile: { workType: "code", complexity: "normal" },
    estimatedInputTokens: 5000
  });
  assert.equal(http.isSubscriptionProvider, false);
  assert.equal(http.quotaBurnSource, "not_applicable");
});

test("11b. reasoningFit is two-sided — under-reasoning is penalized as well as over-reasoning", () => {
  assert.ok(reasoningFit({ reasoningEffort: "max", reasoningDemand: "minimal" }).alignment < 0);
  assert.ok(reasoningFit({ reasoningEffort: "none", reasoningDemand: "maximum" }).alignment < 0);
  assert.equal(reasoningFit({ reasoningEffort: "unknown", reasoningDemand: "high" }).alignment, 0);
});

// ---------------------------------------------------------------- Phase 3

test("12. request capability hard gates exclude candidates that cannot satisfy the contract", () => {
  const caps = { chatCompletions: true, streaming: true, toolCalls: false, structuredOutput: "unknown" };
  assert.equal(checkRequiredCapabilities(caps, ["chatCompletions", "streaming"]).ok, true);
  const toolGate = checkRequiredCapabilities(caps, ["toolCalls"]);
  assert.equal(toolGate.ok, false);
  assert.equal(toolGate.reasonCode, "routing.capabilityUnsupported.toolCalls");
});

test("13. unknown tool capability cannot satisfy a tool request", () => {
  const caps = { chatCompletions: true, toolCalls: "unknown" };
  const gate = checkRequiredCapabilities(caps, ["toolCalls"]);
  assert.equal(gate.ok, false);
  assert.equal(gate.observed, "unknown", "unknown must never be treated as supported");
});

test("13b. builtin CLI providers expose native agent tools separately from OpenAI tool calls", () => {
  const profile = buildCapabilityProfile({ provider: "claude", providerModelId: "claude-opus-5", catalogEntry: { state: "validated", lastSuccessAt: "now" } });
  assert.equal(profile.toolCalls, false);
  assert.equal(profile.chatCompletions, true);
  assert.equal(profile.streaming, true);
});

test("13b. HTTP model metadata can positively establish native tool-call support", () => {
  const profile = buildCapabilityProfile({
    provider: "lmstudio",
    providerModelId: "qwen-tool-model",
    isHttpProvider: true,
    catalogEntry: {
      state: "exposed",
      metadata: { capabilities: { toolCalls: true } }
    }
  });
  assert.equal(profile.chatCompletions, true);
  assert.equal(profile.toolCalls, true);
});

test("13b-2. tool-enabled requests route to a verified execution-capable expert", () => {
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "claude", [{
    modelId: "claude-opus-5",
    state: "validated",
    discoverySource: "documented_candidate"
  }]);
  replaceProviderModels(catalog, "lmstudio", [{
    modelId: "qwen-tool-model",
    state: "exposed",
    discoverySource: "http_models_endpoint",
    metadata: { capabilities: { toolCalls: true } }
  }]);
  const config = {
    modelCatalog: { validationTtlHours: 24 },
    providers: {
      claude: { enabled: true, type: "builtin" },
      lmstudio: { enabled: true, type: "http", baseUrl: "http://x" }
    },
    automaticRouting: { maximumAttempts: 4 }
  };
  const route = selectAutomaticRoute({
    config,
    statuses: { claude: { ok: true }, lmstudio: { ok: true } },
    catalog,
    telemetryStore: { entries: {} },
    taskProfile: buildTaskProfile({
      prompt: "inspect the project",
      body: { tools: [{ type: "function", function: { name: "read_file" } }] }
    }),
    settings: config.automaticRouting
  });
  assert.equal(route.winner.provider, "claude");
  assert.equal(route.winner.capabilities.nativeAgentTools, true);
  assert.ok(route.attemptPlan.every((attempt) => attempt.name === "claude"));
});

test("13c. a parsed reasoning effort is itself evidence that the provider exposes reasoning controls", () => {
  const executionProfile = parseExecutionProfile("cursor", "gpt-5.6-sol-high");
  const profile = buildCapabilityProfile({ provider: "cursor", providerModelId: "gpt-5.6-sol-high", executionProfile });
  assert.equal(profile.reasoningControls, true);
});

// ---------------------------------------------------------------- Phase 4

test("14. a practical provider-wrapper context limit overrides the model-advertised limit", () => {
  const model = buildContextModel({
    provider: "claude",
    canonicalModelId: "claude-opus-5",
    catalogEntry: { metadata: { context_length: 200000 } },
    operatorConfig: { wrapperContextWindow: 32000 },
    outputTokenReserve: 4096,
    safetyMarginRatio: 0
  });
  assert.equal(model.modelAdvertisedContextWindow, 200000);
  assert.equal(model.providerWrapperContextWindow, 32000);
  assert.equal(model.effectiveUsableContextWindow, 32000 - 4096, "the lower practical limit must govern");
});

test("15. unknown context capacity is ineligible for a large request but fine for a small one", () => {
  const unknown = buildContextModel({ provider: "x", canonicalModelId: "mystery-model" });
  assert.equal(unknown.effectiveUsableContextWindow, null);

  const large = checkContextFit({ contextModel: unknown, estimatedInputTokens: 80000, unknownLargeContextThresholdTokens: 50000 });
  assert.equal(large.ok, false);
  assert.equal(large.reasonCode, "routing.unknownContextForLargeRequest");

  const small = checkContextFit({ contextModel: unknown, estimatedInputTokens: 1000, unknownLargeContextThresholdTokens: 50000 });
  assert.equal(small.ok, true);
  assert.equal(small.unknownContext, true);
});

test("16. the output-token reserve counts against context eligibility", () => {
  const model = buildContextModel({
    provider: "x",
    canonicalModelId: "m",
    operatorConfig: { contextWindow: 10000, outputTokenReserve: 2000 },
    safetyMarginRatio: 0
  });
  assert.equal(model.effectiveUsableContextWindow, 8000);
  assert.equal(checkContextFit({ contextModel: model, estimatedInputTokens: 7000, requiredOutputTokens: 2000 }).ok, false);
  assert.equal(checkContextFit({ contextModel: model, estimatedInputTokens: 5000, requiredOutputTokens: 2000 }).ok, true);
});

// ---------------------------------------------------------------- Phase 5

test("17. the task profile is multidimensional — a short bug fix differs from a production regression", () => {
  const trivial = buildTaskProfile({ prompt: "fix a simple typo in the readme", estimatedInputTokens: 200 });
  const severe = buildTaskProfile({
    prompt: "diagnose the root cause of this intermittent production outage causing data loss across services",
    estimatedInputTokens: 120000
  });

  assert.equal(trivial.complexity, "trivial");
  assert.equal(trivial.reasoningDemand, "minimal");
  assert.equal(trivial.qualityPreference, "economy");

  assert.equal(severe.risk, "production");
  assert.equal(severe.complexity, "complex");
  assert.equal(severe.reasoningDemand, "high");
  assert.equal(severe.contextBand, "large");
  assert.equal(severe.qualityPreference, "balanced");
  assert.notEqual(trivial.reasoningDemand, severe.reasoningDemand);
});

test("17b. work type is scored, not first-regex-match", () => {
  // "review" signals outweigh "explain" signals rather than depending on
  // declaration order.
  const profile = buildTaskProfile({ prompt: "review this pull request diff and explain the regression risk" });
  assert.equal(profile.workType, "review");
  assert.ok(profile.workTypeScores.review > 0);
  assert.ok(profile.workTypeScores.explain > 0);
});

test("17c. required capabilities are derived from the actual request shape", () => {
  const profile = buildTaskProfile({
    prompt: "return structured data",
    body: { stream: true, tools: [{ type: "function" }], response_format: { type: "json_schema" } }
  });
  assert.ok(profile.requiredCapabilities.includes("streaming"));
  assert.ok(profile.requiredCapabilities.includes("toolExecution"));
  assert.equal(profile.outputContract, "json_schema");
  // PARAGON-D-004E: structured output is verified after the fact (parse the
  // response, escalate if invalid), so it is a scoring preference rather than
  // a hard gate. Gating on it excluded every text provider from every
  // response_format request.
  assert.ok(!profile.requiredCapabilities.includes("structuredOutput"));
  assert.ok(!profile.requiredCapabilities.includes("jsonSchema"));
  assert.ok(profile.postVerifiedCapabilities.includes("structuredOutput"));
  assert.ok(profile.postVerifiedCapabilities.includes("jsonSchema"));
});

// ---------------------------------------------------------------- Phase 9

test("18. same-provider alternate models enter the attempt plan", () => {
  const config = { providers: { cursor: { enabled: true }, codex: { enabled: true } } };
  const ranked = [
    { provider: "cursor", providerModelId: "a-high", canonicalModelId: "a", excluded: false, expectedUtility: 10 },
    { provider: "cursor", providerModelId: "a-low", canonicalModelId: "a", excluded: false, expectedUtility: 9 },
    { provider: "codex", providerModelId: "b", canonicalModelId: "b", excluded: false, expectedUtility: 8 }
  ];
  const plan = buildAttemptPlan(ranked, config, { maximumAttempts: 4, maxPerProvider: 2 });
  assert.deepEqual(plan.map((a) => a.registryModel), ["a-high", "a-low", "b"]);
  assert.equal(plan[1].alternateIndexForProvider, 1);
});

test("19. a provider-wide failure skips every remaining attempt for that provider", () => {
  const plan = [
    { name: "cursor", registryModel: "a-high", executionProfile: "effort:high" },
    { name: "cursor", registryModel: "a-low", executionProfile: "effort:low" },
    { name: "codex", registryModel: "b", executionProfile: "default" }
  ];
  const decision = planNextAfterFailure({ classification: "QUOTA_EXHAUSTED", attempt: plan[0], remainingPlan: plan.slice(1) });
  assert.equal(decision.action, "skip_provider");
  const filtered = applyFailureToPlan(plan, { attempt: plan[0], classification: "QUOTA_EXHAUSTED" });
  assert.deepEqual(filtered.map((a) => a.registryModel), ["b"]);
});

test("20. a model-specific failure preserves other models from the same provider", () => {
  const plan = [
    { name: "cursor", registryModel: "a-high", executionProfile: "effort:high" },
    { name: "cursor", registryModel: "a-low", executionProfile: "effort:low" },
    { name: "codex", registryModel: "b", executionProfile: "default" }
  ];
  const decision = planNextAfterFailure({ classification: "MODEL_NOT_FOUND", attempt: plan[0], remainingPlan: plan.slice(1) });
  assert.equal(decision.action, "next_same_provider");
  const filtered = applyFailureToPlan(plan, { attempt: plan[0], classification: "MODEL_NOT_FOUND" });
  assert.deepEqual(filtered.map((a) => a.registryModel), ["a-low", "b"], "the sibling model must survive");
});

test("20b. a transient failure retries within budget then advances", () => {
  const attempt = { name: "cursor", registryModel: "a", executionProfile: "default" };
  assert.equal(planNextAfterFailure({ classification: "RATE_LIMITED", attempt, remainingPlan: [], retriesUsed: 0 }).action, "retry");
  assert.equal(planNextAfterFailure({ classification: "RATE_LIMITED", attempt, remainingPlan: [], retriesUsed: 1 }).action, "next_provider");
});

// ---------------------------------------------------------------- Phase 10

test("21. tie-breaking is explicit and never falls back to insertion order", () => {
  const base = (overrides) => ({
    provider: "p",
    providerModelId: "m",
    expectedUtility: 10,
    excluded: false,
    components: {
      successSource: "prior",
      probabilityOfSuccessfulCompletion: 0.85,
      expectedTotalResourceCost: 5,
      expectedQuotaScarcityPenalty: 0,
      measuredLatencyP95Ms: null
    },
    telemetry: { measurementConfidence: "none", lastSuccessAt: null },
    ...overrides
  });

  // Equal utility, differing cost -> cheaper wins.
  const cheap = base({ providerModelId: "cheap", components: { ...base({}).components, expectedTotalResourceCost: 2 } });
  const pricey = base({ providerModelId: "pricey" });
  assert.ok(compareCandidates(cheap, pricey) < 0);

  // Equal utility and cost, differing evidence -> measured wins.
  const measured = base({ providerModelId: "measured", components: { ...base({}).components, successSource: "measured" } });
  assert.ok(compareCandidates(measured, pricey) < 0);

  // Fully equal -> deterministic lexical anchor, not array position.
  const a = base({ provider: "aaa", providerModelId: "x" });
  const b = base({ provider: "zzz", providerModelId: "x" });
  assert.ok(compareCandidates(a, b) < 0);
  assert.ok(compareCandidates(b, a) > 0);
});

test("22. confidence reflects score margin and evidence, not merely candidate count", () => {
  const candidate = (utility, evidenceShare) => ({
    excluded: false,
    expectedUtility: utility,
    measuredEvidenceShare: evidenceShare,
    telemetry: { measurementConfidence: evidenceShare > 0.5 ? "high" : "none" },
    capabilities: { capabilityConfidence: "high" },
    contextModel: { contextConfidence: "high" },
    benchmark: { matchMethod: "exact", matchConfidence: "high" },
    components: { uncertaintyPenalty: 0.1 }
  });

  const wide = routingConfidence([candidate(100, 0.8), candidate(40, 0.8)]);
  const narrow = routingConfidence([candidate(100, 0.1), candidate(99.9, 0.1)]);
  assert.equal(wide.level, "high");
  assert.equal(narrow.level, "low", "a near-tie built on priors must not report high confidence");
  assert.ok(wide.margin > narrow.margin);

  assert.equal(routingConfidence([candidate(10, 0.5)]).level, "only_eligible");
  assert.equal(routingConfidence([candidate(10, 0.5), candidate(1, 0.5)], { explicitlyForced: true }).level, "explicit_validated");
});

// ---------------------------------------------------------------- Phase 6

test("26. telemetry stores no prompts or responses", () => {
  const store = defaultTelemetryStore();
  recordOutcome(store, {
    provider: "cursor",
    providerModelId: "m-high",
    executionProfile: "effort:high",
    taskProfile: { workType: "code", complexity: "normal", contextBand: "small", outputContract: "code" },
    success: true,
    completionLatencyMs: 1200,
    usage: { inputTokens: 100, visibleOutputTokens: 200, reasoningTokens: 300 }
  });
  const serialized = JSON.stringify(store);
  assert.ok(!/prompt|response|content|message/i.test(serialized), "no content-bearing field may appear in the store");
  const entry = store.entries[telemetryKey({ provider: "cursor", providerModelId: "m-high", executionProfile: "effort:high", workType: "code", complexity: "normal", contextBand: "small", outputContract: "code" })];
  assert.equal(entry.successCount, 1);
  assert.equal(entry.observedReasoningTokens, 300);
});

test("27. rolling aggregates stay bounded regardless of request volume", () => {
  const store = defaultTelemetryStore();
  for (let i = 0; i < 500; i += 1) {
    recordOutcome(store, {
      provider: "cursor",
      providerModelId: "m-high",
      executionProfile: "effort:high",
      taskProfile: { workType: "code", complexity: "normal", contextBand: "small", outputContract: "code" },
      success: i % 7 !== 0,
      completionLatencyMs: 500 + i,
      usage: { inputTokens: 100, visibleOutputTokens: 200, reasoningTokens: 50 }
    });
  }
  // Two keys only (task-specific + model-wide); no per-request growth.
  assert.equal(Object.keys(store.entries).length, 2);
  const serializedSize = JSON.stringify(store).length;
  assert.ok(serializedSize < 4000, `store must stay small, got ${serializedSize} bytes`);

  const read = readTelemetry(store, { provider: "cursor", providerModelId: "m-high", executionProfile: "effort:high", workType: "code", complexity: "normal", contextBand: "small", outputContract: "code" });
  assert.equal(read.sampleCount, 500);
  assert.ok(read.completionLatencyP50 != null);
});

test("27b. success probability is shrunk toward a prior so one lucky request cannot outrank dense evidence", () => {
  const lucky = defaultTelemetryStore();
  recordOutcome(lucky, { provider: "p", providerModelId: "new", success: true, taskProfile: {} });
  const luckyRead = readTelemetry(lucky, { provider: "p", providerModelId: "new" });
  assert.ok(luckyRead.smoothedSuccessProbability < 0.8, `1/1 must not read as ~1.0, got ${luckyRead.smoothedSuccessProbability}`);

  const proven = defaultTelemetryStore();
  for (let i = 0; i < 200; i += 1) {
    recordOutcome(proven, { provider: "p", providerModelId: "proven", success: true, taskProfile: {} });
  }
  const provenRead = readTelemetry(proven, { provider: "p", providerModelId: "proven" });
  assert.ok(provenRead.smoothedSuccessProbability > luckyRead.smoothedSuccessProbability);
});

test("27c. pruning drops entries outside the retention window", () => {
  const store = defaultTelemetryStore();
  recordOutcome(store, { provider: "p", providerModelId: "old", success: true, taskProfile: {}, now: new Date(Date.now() - 100 * 24 * 3_600_000).toISOString() });
  recordOutcome(store, { provider: "p", providerModelId: "fresh", success: true, taskProfile: {} });
  const { removed } = pruneTelemetry(store, { retentionDays: 30 });
  assert.ok(removed > 0);
  assert.ok(Object.keys(store.entries).some((k) => k.includes("fresh")));
  assert.ok(!Object.keys(store.entries).some((k) => k.includes("old")));
});

// ------------------------------------------------- the one production engine

test("24/25. the engine produces a ranking and a plan without executing any provider", () => {
  const config = {
    routing: { priority: "balanced" },
    providers: { cursor: { enabled: true, type: "builtin", models: [] } },
    modelCatalog: { validationTtlHours: 24 }
  };
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "cursor", [
    { modelId: "gpt-5.6-sol-max", displayName: "sol max", state: "validated", discoverySource: "cli_command" },
    { modelId: "gpt-5.6-sol-low", displayName: "sol low", state: "validated", discoverySource: "cli_command" }
  ]);
  const taskProfile = buildTaskProfile({ prompt: "implement a function", estimatedInputTokens: 1000 });

  const route = selectAutomaticRoute({ config, statuses: {}, catalog, telemetryStore: defaultTelemetryStore(), benchmarkRows: [], taskProfile, settings: {} });
  assert.ok(route.winner, "the engine must produce a winner");
  assert.equal(route.eligibleCount, 2);
  // Both execution profiles are represented separately.
  const efforts = route.ranked.filter((c) => !c.excluded).map((c) => c.reasoningEffort).sort();
  assert.deepEqual(efforts, ["low", "max"]);
  assert.ok(route.attemptPlan.length >= 1);
  // Selection is pure computation: the plan carries the provider config it
  // would dispatch with, but nothing here spawns or calls a provider.
  assert.ok(route.attemptPlan.every((a) => a.config && typeof a.config === "object"));
});

test("24b. the engine reports exactly one decision per call, with no second ranking to compare against", () => {
  const config = {
    routing: { priority: "balanced" },
    providers: { cursor: { enabled: true, type: "builtin", models: [] } },
    modelCatalog: { validationTtlHours: 24 }
  };
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "cursor", [
    { modelId: "gpt-5.6-sol-low", displayName: "sol low", state: "validated", discoverySource: "cli_command" }
  ]);
  const taskProfile = buildTaskProfile({ prompt: "implement a function", estimatedInputTokens: 100 });
  const route = selectAutomaticRoute({ config, statuses: {}, catalog, telemetryStore: defaultTelemetryStore(), benchmarkRows: [], taskProfile, settings: {} });

  // No comparison surface exists on the result: there is no alternative
  // engine's winner, no agreement flag, and no advisory ranking.
  for (const key of ["shadow", "agrees", "disagrees", "live", "liveRouteSelector", "shadowWinner"]) {
    assert.equal(key in route, false, `${key} must not exist on a routing decision`);
  }
  assert.equal(route.reasonCode, "automatic.expectedUtility");
});

test("25b. routeActivity keeps planned, executed and failed provider-models distinct and stays bounded", () => {
  const activity = createRouteActivityStore({ activityLimit: 10 });
  activity.recordPlanned({ taskType: "code", attemptPlan: [{ order: 1, provider: "cursor", model: "m1" }] });
  activity.recordFailed({ provider: "cursor", model: "m1", reason: "cursor reached its usage limit" });
  activity.recordExecuted({ provider: "codex", model: "gpt-5.4" });

  // A failure must never be reported as the provider's last used model.
  assert.equal(activity.lastExecuted("cursor"), null);
  assert.equal(activity.lastFailure("cursor").model, "m1");
  assert.equal(activity.lastExecuted("codex").model, "gpt-5.4");
  // A plan is a decision, not evidence of execution.
  assert.equal(activity.plan().plan[0].provider, "cursor");

  for (let i = 0; i < 50; i += 1) {
    activity.recordRequest({ success: true, provider: "codex", model: "gpt-5.4", durationMs: 10 });
  }
  assert.equal(activity.recent({ limit: 50 }).length, 10, "the activity buffer must not grow with traffic");
});

// ---------------------------------------------------------------- invariants

test("28/29. every routing-integrity invariant holds in the production engine", () => {
  const config = {
    routing: { priority: "balanced" },
    providers: {
      cursor: { enabled: true, type: "builtin", models: [{ id: "stale-configured-model" }] },
      unassessed: { enabled: true, type: "builtin", models: [{ id: "config-only" }] }
    },
    modelCatalog: { validationTtlHours: 24 }
  };
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "cursor", [
    { modelId: "good-model", displayName: "good", state: "validated", discoverySource: "cli_command", metadata: { context_length: 200000 } },
    { modelId: "stale-configured-model", displayName: "stale", state: "rejected", discoverySource: "cli_command" },
    { modelId: "text-embedding-thing", displayName: "emb", state: "exposed", discoverySource: "http_models_endpoint" }
  ]);
  const taskProfile = buildTaskProfile({ prompt: "implement a function", estimatedInputTokens: 100 });
  const route = selectAutomaticRoute({ config, statuses: {}, catalog, telemetryStore: defaultTelemetryStore(), benchmarkRows: [], taskProfile, settings: {} });

  const eligibleIds = route.ranked.filter((c) => !c.excluded).map((c) => c.providerModelId);
  assert.ok(eligibleIds.includes("good-model"));
  assert.ok(!eligibleIds.includes("stale-configured-model"), "a catalog-rejected model must stay excluded");
  assert.ok(!eligibleIds.includes("text-embedding-thing"), "a non-chat model must stay excluded");
  assert.ok(!eligibleIds.includes("config-only"), "an unassessed provider must not gain config trust");
  const pending = route.ranked.find((c) => c.provider === "unassessed");
  assert.equal(pending.reasonCode, "routing.providerPendingAssessment");

  // Every attempt is traceable to an eligible ranked row. The executable plan
  // carries `registryModel` — the row it was derived from — which is exactly
  // what makes this check meaningful rather than circular.
  for (const attempt of route.attemptPlan) {
    assert.ok(eligibleIds.includes(attempt.registryModel), `${attempt.registryModel} is not an eligible candidate`);
  }
  assert.deepEqual(verifyPlanAgainstCandidates(route.attemptPlan, route.ranked, config), []);
});

test("29b. utility weights are exported for inspection rather than hidden in the formula", () => {
  assert.ok(UTILITY_WEIGHTS.qualityScale > 0);
  assert.ok("resourceCostScale" in UTILITY_WEIGHTS);
  assert.ok("uncertaintyScale" in UTILITY_WEIGHTS);
});
