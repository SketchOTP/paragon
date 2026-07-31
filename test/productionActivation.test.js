/**
 * PARAGON-D-004E — production activation.
 *
 * Unit-level proof for the activation contract:
 *
 *  - there is exactly one routing engine and the retired one is gone
 *  - real usage is captured when a provider reports it, and unknown usage is
 *    penalized rather than costed as free
 *  - subscription allowance exhaustion is a hard gate with a parsed reset
 *  - the legacy routing schema is removed, with a backup, preserving everything
 *    that carries credentials or connectivity
 *  - routing priority resolves to documented weights and nothing else
 *
 * HTTP-level proof lives in productionActivation.api.test.js.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { selectAutomaticRoute } from "../src/routing/automaticRouting.js";
import { estimateEffectiveCost, estimateReasoningTokens, reasoningFit } from "../src/routing/costModel.js";
import { defaultTelemetryStore, recordOutcome, readTelemetry } from "../src/routing/outcomeTelemetry.js";
import { rankCandidates, UTILITY_WEIGHTS } from "../src/routing/expectedUtility.js";
import { buildTaskProfile } from "../src/routing/taskProfile.js";
import { createQuotaStateStore, parseQuotaReset } from "../src/routing/quotaState.js";
import {
  DEFAULT_ROUTING_PRIORITY,
  ROUTING_PRIORITIES,
  normalizeRoutingPriority,
  resolveUtilityWeights,
  routingPriorityDescription
} from "../src/routing/routingPriority.js";
import {
  extractClaudeCliUsage,
  extractOpenAiUsage,
  extractStructuredCliContent,
  extractStructuredCliUsage,
  unknownUsage
} from "../src/routing/usageEvidence.js";
import { migrateRoutingSchema, needsRoutingSchemaMigration } from "../src/configMigrate.js";
import { CONFIG_VERSION, defaultConfig } from "../src/defaultConfig.js";
import { classifyModelFailure } from "../src/modelCatalog.js";
import { defaultCatalog, replaceProviderModels } from "../src/modelCatalog.js";
import { resetForTests } from "../src/orchestration/liveEnforcement.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

test.beforeEach(() => {
  resetForTests();
});

// ============================================================ 1-6. one engine

test("1/2. the retired scorer is gone from the tree, so it cannot be the request selector", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "src/routing/router.js")), false, "the legacy scorer module must not exist");
  // And nothing imports it.
  const sources = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".js")) {
        sources.push(full);
      }
    }
  };
  walk(path.join(repoRoot, "src"));
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes("routing/router.js"), `${file} still imports the retired scorer`);
    assert.ok(!/\bscoringMethodology\b/.test(text), `${file} still references the retired scoring methodology`);
    assert.ok(!/\brankRegistryByTask\b/.test(text), `${file} still references the retired task-ranking helper`);
  }
});

test("3/5. no shadow runtime remains in the shipped tree", () => {
  for (const file of ["src/routing/shadowEngine.js", "src/routing/shadowStore.js", "src/deprecatedConfig.js"]) {
    assert.equal(fs.existsSync(path.join(repoRoot, file)), false, `${file} must be gone`);
  }
  // No shadow record store, no shadow settings API, no shadow headers.
  const server = fs.readFileSync(path.join(repoRoot, "src/server.js"), "utf8");
  const api = fs.readFileSync(path.join(repoRoot, "src/openaiApi.js"), "utf8");
  for (const marker of ["shadowStore", "shadow-records", "routing-intelligence", "X-Paragon-Shadow"]) {
    assert.ok(!server.includes(marker), `server must not expose ${marker}`);
    assert.ok(!api.includes(marker), `the request path must not reference ${marker}`);
  }
});

test("4. the request path emits no shadow response header", () => {
  const api = fs.readFileSync(path.join(repoRoot, "src/openaiApi.js"), "utf8");
  const headers = [...api.matchAll(/"(X-Paragon-[A-Za-z-]+)"/g)].map((m) => m[1]);
  assert.ok(headers.length > 0, "the request path must still set route headers");
  assert.ok(!headers.some((h) => /shadow/i.test(h)), `no shadow header may be emitted: ${headers.join(", ")}`);
});

test("6. the request path computes a route exactly once", () => {
  const api = fs.readFileSync(path.join(repoRoot, "src/openaiApi.js"), "utf8");
  const calls = [...api.matchAll(/selectAutomaticRoute\(/g)];
  assert.equal(calls.length, 1, "exactly one routing computation may occur per request");
  // And there is no second engine to compare against.
  assert.ok(!/computeShadowRoute|scoreCandidate\(/.test(api));
});

test("16. provider preference is an explicit scorer input", () => {
  assert.equal(UTILITY_WEIGHTS.providerPreferenceScale, 3);
  const expectedUtility = fs.readFileSync(path.join(repoRoot, "src/routing/expectedUtility.js"), "utf8");
  assert.ok(!/taskRoutes\s*\[/.test(expectedUtility), "the scorer must not read a task-provider mapping");
  assert.ok(!/taskRoutes\s*=/.test(expectedUtility));
  assert.match(expectedUtility, /providerPreferenceTerm/);
});

// ============================================================ 8-12. usage

test("8. real HTTP usage is captured when the provider reports it", () => {
  const usage = extractOpenAiUsage({
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 900,
      total_tokens: 2100,
      completion_tokens_details: { reasoning_tokens: 400 }
    }
  });
  assert.equal(usage.inputTokens, 1200);
  // completion_tokens is the total completion including reasoning, so visible
  // output is the remainder — reporting both at face value would double-count.
  assert.equal(usage.visibleOutputTokens, 500);
  assert.equal(usage.reasoningTokens, 400);
  assert.equal(usage.totalBilledTokens, 2100);
  assert.equal(usage.usageSource, "http_response_usage");
  assert.equal(usage.usageConfidence, "high");
  assert.equal(usage.usageUnknown, false);
});

test("9. CLI usage is captured when the provider reports it", () => {
  // The real shape emitted by `claude --output-format json`, verified against
  // the installed CLI rather than assumed.
  const envelope = {
    type: "result",
    total_cost_usd: 0.020251,
    result: "OK",
    usage: { input_tokens: 9, cache_creation_input_tokens: 9421, cache_read_input_tokens: 0, output_tokens: 280 }
  };
  const usage = extractClaudeCliUsage(envelope);
  assert.equal(usage.inputTokens, 9430, "cache-creation and cache-read input are real billed input");
  assert.equal(usage.visibleOutputTokens, 280);
  assert.equal(usage.monetaryCost, 0.020251);
  assert.equal(usage.usageSource, "provider_cli_structured");
  // Claude folds reasoning into output_tokens, so it is unknown — not zero.
  assert.equal(usage.reasoningTokens, null);

  // The same envelope read through the generic entry point, as a JSONL stream.
  const jsonl = `{"type":"turn.started"}\n${JSON.stringify(envelope)}\n`;
  assert.equal(extractStructuredCliUsage(jsonl).inputTokens, 9430);
  assert.equal(extractStructuredCliContent(jsonl), "OK", "content must be unwrapped from the envelope");
});

test("9b. a plain-text CLI reports unknown usage rather than a fabricated figure", () => {
  const usage = extractStructuredCliUsage("OK\n");
  assert.equal(usage.usageUnknown, true);
  assert.equal(usage.usageSource, "unknown");
  for (const field of ["inputTokens", "visibleOutputTokens", "reasoningTokens", "totalBilledTokens", "monetaryCost"]) {
    assert.equal(usage[field], null, `${field} must be null, not zero`);
  }
});

test("10. unknown usage is never treated as zero — not in the record, not in the store", () => {
  const usage = unknownUsage("provider reported nothing");
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.totalBilledTokens, null);

  // `Number(null)` is 0 and finite, so an absent field could silently be
  // averaged in as a zero measurement. It must not be.
  const store = defaultTelemetryStore();
  recordOutcome(store, {
    provider: "p",
    providerModelId: "m",
    executionProfile: "default",
    success: true,
    usage
  });
  const entry = Object.values(store.entries)[0];
  assert.equal(entry.observedInputTokens, null, "unknown usage must not be recorded as zero tokens");
  assert.equal(entry.observedVisibleOutputTokens, null);
  assert.equal(entry.observedReasoningTokens, null);
  assert.equal(entry.observedTotalBilledTokens, null);
  assert.equal(entry.usageUnknownCount, 1);
  assert.equal(entry.usageObservationCount, 0);
});

test("11. unknown reasoning consumption is costed conservatively and penalized, never free", () => {
  const unknownProfileCost = estimateEffectiveCost({
    provider: "lmstudio",
    isHttpProvider: true,
    executionProfile: { reasoningEffort: "unknown", speedMode: "standard" },
    taskProfile: { workType: "code", complexity: "normal" },
    estimatedInputTokens: 1000
  });
  assert.equal(unknownProfileCost.reasoningEstimateSource, "unknown");
  assert.ok(unknownProfileCost.reasoningTokensAssumedConservative, "unknown reasoning must be flagged");
  assert.ok(
    unknownProfileCost.conservativeReasoningFloorTokens > 0,
    "an unknown reasoning profile must be charged a conservative floor, not zero"
  );
  assert.ok(unknownProfileCost.estimatedTotalResourceCost > 0, "unknown usage must never produce a zero-cost candidate");
  assert.ok(unknownProfileCost.costUncertainty >= 0.5, "unknown reasoning must carry a large cost-uncertainty penalty");
});

test("11b. an unpriced metered provider is not a free provider", () => {
  const cost = estimateEffectiveCost({
    provider: "lmstudio",
    isHttpProvider: true,
    executionProfile: { reasoningEffort: "low", speedMode: "standard" },
    taskProfile: { workType: "code", complexity: "normal" },
    estimatedInputTokens: 1000,
    benchmarkPricing: null
  });
  assert.equal(cost.pricingAvailable, false);
  assert.equal(cost.unpricedMeteredProvider, true);
  assert.ok(cost.estimatedTotalResourceCost > 0, "absence of pricing must not become a perfect cost score");
});

test("11c. the uncertainty penalty reaches the utility score for an unmeasured candidate", () => {
  const candidate = {
    provider: "lmstudio",
    providerModelId: "some-model",
    catalogEligible: true,
    health: "healthy",
    isHttpProvider: true,
    costClass: "standard",
    executionProfile: { reasoningEffort: "unknown", speedMode: "unknown", canonicalModelId: "some-model", executionProfile: "default" },
    capabilities: { chatCompletions: true },
    contextModel: { effectiveUsableContextWindow: 200000, contextConfidence: "low", outputTokenReserve: 1000 },
    benchmark: null,
    telemetry: { sampleCount: 0, measurementConfidence: "none" }
  };
  const { ranked } = rankCandidates([candidate], {
    taskProfile: buildTaskProfile({ prompt: "implement a function", estimatedInputTokens: 100 }),
    minimumSamplesForMeasuredEstimate: 10
  });
  const scored = ranked[0];
  assert.ok(scored.components.uncertaintyPenalty > 0);
  assert.ok(scored.components.uncertaintyTerm > 0, "the penalty must actually reduce utility");
  assert.ok(scored.components.uncertaintyReasons.some((r) => /reasoning-token consumption unknown/.test(r)));
});

test("12. provider-returned reasoning tokens override the ordinal prior immediately", () => {
  const prior = estimateReasoningTokens({ reasoningEffort: "max", expectedVisibleOutputTokens: 1000 });
  assert.equal(prior.reasoningEstimateSource, "ordinal_prior");

  // One real observation from the provider outranks the prior, without waiting
  // for the measured-history sample threshold.
  const reported = estimateReasoningTokens({
    reasoningEffort: "max",
    expectedVisibleOutputTokens: 1000,
    telemetry: {
      observedReasoningTokens: 120,
      sampleCount: 1,
      usageSource: "provider_cli_structured",
      usageObservationCount: 1
    },
    minimumSamplesForMeasuredEstimate: 10
  });
  assert.equal(reported.reasoningEstimateSource, "provider_reported_usage");
  assert.equal(reported.expectedReasoningTokens, 120);
  assert.ok(reported.expectedReasoningTokens < prior.expectedReasoningTokens, "measurement must displace the guess");
});

test("38. routing telemetry stores no prompt or response content", () => {
  const store = defaultTelemetryStore();
  recordOutcome(store, {
    provider: "p",
    providerModelId: "m",
    executionProfile: "default",
    success: true,
    responseChars: 4200,
    usage: extractOpenAiUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }),
    taskProfile: buildTaskProfile({ prompt: "a very secret internal prompt about acquisitions", estimatedInputTokens: 100 })
  });
  const serialized = JSON.stringify(store);
  assert.ok(!serialized.includes("secret internal prompt"));
  assert.ok(!serialized.includes("acquisitions"));
  // Only counts and aggregates.
  const entry = Object.values(store.entries)[0];
  assert.equal(entry.requestCount, 1);
  assert.equal(entry.observedTotalBilledTokens, 30);
});

// ============================================================ 14. quota gate

test("14. a quota-exhausted provider is excluded after classification, with a parsed reset", () => {
  // The real cursor-agent message, verbatim.
  const detail =
    "ActionRequiredError: You've hit your usage limit You've saved $2504 on API model usage this month with Ultra. " +
    "Switch to a different model or set a Spend Limit to continue with this model. " +
    "Your usage limits will reset when your monthly cycle ends on 8/12/2099.";

  // It must classify as an exhausted allowance, not a transient failure.
  assert.equal(classifyModelFailure({ message: detail }), "QUOTA_EXHAUSTED");

  const parsed = parseQuotaReset(detail);
  assert.equal(parsed.resetSource, "provider_calendar_date");
  assert.match(parsed.resetAt, /^2099-08-12/);

  const quotaState = createQuotaStateStore();
  const state = quotaState.recordQuotaFailure("cursor", { classification: "QUOTA_EXHAUSTED", detail });
  assert.equal(state.observedFailures, 1);
  assert.equal(quotaState.isExhausted("cursor"), true);

  // And it is a hard exclusion in the live engine, not a scoring penalty.
  const config = {
    routing: { priority: "balanced" },
    providers: { cursor: { enabled: true, type: "builtin", models: [] }, claude: { enabled: true, type: "builtin", models: [] } },
    modelCatalog: { validationTtlHours: 24 }
  };
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "cursor", [
    { modelId: "composer-2.5", displayName: "c", state: "validated", discoverySource: "cli_command" }
  ]);
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-sonnet-5", displayName: "s", state: "validated", discoverySource: "cli_command" }
  ]);
  const route = selectAutomaticRoute({
    config,
    statuses: {},
    catalog,
    telemetryStore: defaultTelemetryStore(),
    benchmarkRows: [],
    taskProfile: buildTaskProfile({ prompt: "implement a function", estimatedInputTokens: 100 }),
    settings: {},
    quotaState
  });
  const excluded = route.ranked.find((c) => c.provider === "cursor");
  assert.equal(excluded.excluded, true);
  assert.equal(excluded.reasonCode, "eligibility.quotaExhausted");
  assert.equal(route.winner.provider, "claude");
  assert.ok(!route.attemptPlan.some((a) => a.name === "cursor"), "an exhausted provider must not be planned at all");
});

test("14b. a successful execution is authoritative recovery evidence", () => {
  const quotaState = createQuotaStateStore();
  quotaState.recordQuotaFailure("cursor", { classification: "QUOTA_EXHAUSTED", detail: "usage limit" });
  assert.equal(quotaState.isExhausted("cursor"), true);
  quotaState.recordSuccess("cursor");
  assert.equal(quotaState.isExhausted("cursor"), false, "the provider just proved it is serving");
});

test("14c. an unparseable quota error still bounds the exclusion instead of exiling the provider", () => {
  const quotaState = createQuotaStateStore();
  const state = quotaState.recordQuotaFailure("p", { classification: "QUOTA_EXHAUSTED", detail: "out of credit" });
  assert.equal(state.resetSource, "bounded_default");
  assert.ok(Date.parse(state.resetAt) > Date.now());
  assert.ok(Date.parse(state.resetAt) < Date.now() + 25 * 3_600_000, "a default exclusion must be short, not a billing cycle");
});

test("14d. quota scarcity is a relative signal derived from observation, never an invented cost", () => {
  const quotaState = createQuotaStateStore();
  const config = { providers: { a: { enabled: true }, b: { enabled: true }, c: { enabled: false } } };
  assert.equal(quotaState.scarcity(config), 0);
  quotaState.recordQuotaFailure("a", { classification: "QUOTA_EXHAUSTED", detail: "usage limit" });
  assert.equal(quotaState.scarcity(config), 0.5, "one of two enabled providers exhausted");
});

test("14e. an exhausted provider returns to routing on its own once the reset passes", () => {
  const quotaState = createQuotaStateStore();
  const soon = new Date(Date.now() + 40).toISOString();
  quotaState.recordQuotaFailure("cursor", { classification: "QUOTA_EXHAUSTED", detail: `resets at ${soon}` });
  assert.equal(quotaState.isExhausted("cursor"), true);

  // No restart, no manual step: the next read past the reset re-admits it.
  assert.equal(quotaState.isExhausted("cursor", { now: Date.now() + 60_000 }), false);
  assert.equal(quotaState.state("cursor", { now: Date.now() + 60_000 }), null);
  assert.equal(quotaState.scarcity({ providers: { cursor: { enabled: true } } }, { now: Date.now() + 60_000 }), 0);
});

test("14f. quota state survives a restart, but a window that closed while down is not replayed", () => {
  const open = new Date(Date.now() + 3_600_000).toISOString();
  const closed = new Date(Date.now() - 1000).toISOString();

  let persisted = null;
  const first = createQuotaStateStore({ onChange: (snapshot) => (persisted = snapshot) });
  first.recordQuotaFailure("cursor", { classification: "QUOTA_EXHAUSTED", detail: `resets at ${open}` });
  assert.ok(persisted.cursor, "the record must be handed to the persistence hook");

  // Restart: an allowance that resets on the 12th is still spent afterwards.
  const restored = createQuotaStateStore({ initial: persisted });
  assert.equal(restored.isExhausted("cursor"), true, "a still-open window must survive a restart");

  // But a record whose window already closed must not be replayed.
  const stale = createQuotaStateStore({
    initial: { cursor: { resetAt: closed, classification: "QUOTA_EXHAUSTED", observedFailures: 1 } }
  });
  assert.equal(stale.isExhausted("cursor"), false);
});

test("14g. a success clears the exclusion and is persisted", () => {
  let persisted = null;
  const quotaState = createQuotaStateStore({ onChange: (snapshot) => (persisted = snapshot) });
  quotaState.recordQuotaFailure("cursor", { classification: "QUOTA_EXHAUSTED", detail: "usage limit" });
  assert.ok(persisted.cursor);
  quotaState.recordSuccess("cursor");
  assert.deepEqual(persisted, {}, "recovery must be persisted too, not just held in memory");
});

// ============================================ ranking must not reward legibility

test("a model is not scored worse merely because its provider does not encode reasoning effort in model ids", () => {
  // cursor declares a model-id grammar, so `-medium` parses as an effort.
  // codex does not, so its effort is unknown. That is a fact about the
  // provider's naming, not about the model — it must not become a scoring
  // advantage for the one PARAGON happens to be able to read.
  const shared = {
    catalogEligible: true,
    health: "healthy",
    isHttpProvider: false,
    costClass: "standard",
    capabilities: { chatCompletions: true, streaming: true, capabilityConfidence: "high" },
    contextModel: { effectiveUsableContextWindow: 400000, contextConfidence: "high", outputTokenReserve: 4096 },
    benchmark: null,
    telemetry: null
  };
  const taskProfile = buildTaskProfile({ prompt: "implement a function", estimatedInputTokens: 2000 });
  assert.equal(taskProfile.reasoningDemand, "medium");

  const { ranked } = rankCandidates(
    [
      {
        ...shared,
        provider: "cursor",
        providerModelId: "m-medium",
        executionProfile: { canonicalModelId: "m", reasoningEffort: "medium", speedMode: "standard", executionProfile: "effort:medium" }
      },
      {
        ...shared,
        provider: "codex",
        providerModelId: "m",
        executionProfile: { canonicalModelId: "m", reasoningEffort: "unknown", speedMode: "unknown", executionProfile: "default" }
      }
    ],
    { taskProfile, unknownLargeContextThresholdTokens: 50000 }
  );

  const parseable = ranked.find((c) => c.provider === "cursor");
  const opaque = ranked.find((c) => c.provider === "codex");

  // Matching the demand is the baseline, not a bonus — so neither collects a
  // positive reasoning-fit term.
  assert.equal(parseable.components.reasoningFitTerm, 0, "a parsed, matching effort must not be rewarded");
  assert.equal(opaque.components.reasoningFitTerm, 0, "an unknown effort must not be punished on fit");

  // The opaque model still carries a genuine uncertainty penalty — not knowing
  // is a real cost — but it must be that penalty alone, not a compounded one.
  assert.ok(opaque.components.uncertaintyPenalty > parseable.components.uncertaintyPenalty);
  assert.ok(
    Math.abs(opaque.expectedUtility - parseable.expectedUtility) < UTILITY_WEIGHTS.qualityScale * 0.25,
    `legibility alone must not dominate the score (gap was ${Math.abs(opaque.expectedUtility - parseable.expectedUtility).toFixed(1)})`
  );
});

test("unknown reasoning effort is costed at the neutral default, not assumed worst-case", () => {
  const forEffort = (reasoningEffort) =>
    estimateEffectiveCost({
      provider: "codex",
      isHttpProvider: false,
      executionProfile: { reasoningEffort, speedMode: "standard" },
      taskProfile: { workType: "code", complexity: "normal" },
      estimatedInputTokens: 2000
    });

  const unknown = forEffort("unknown");
  const medium = forEffort("medium");
  const high = forEffort("high");

  assert.ok(unknown.reasoningTokensAssumedConservative);
  // Not zero — that is the property that matters.
  assert.ok(unknown.conservativeReasoningFloorTokens > 0);
  // But not worst-case either: "unknown" overwhelmingly means "this provider
  // does not encode effort in its ids", not "this model reasons a lot".
  assert.ok(
    unknown.effectiveExpectedTokens <= medium.effectiveExpectedTokens,
    "unknown must not be charged more than the neutral default"
  );
  assert.ok(unknown.effectiveExpectedTokens < high.effectiveExpectedTokens, "unknown must not be charged as high effort");
  // The honesty burden is carried by uncertainty, not by a pessimistic guess.
  assert.ok(unknown.costUncertainty >= medium.costUncertainty + 0.2);
});

test("under-reasoning is penalized harder than over-reasoning, because only over-reasoning is already priced", () => {
  const over = reasoningFit({ reasoningEffort: "max", reasoningDemand: "minimal" });
  const under = reasoningFit({ reasoningEffort: "none", reasoningDemand: "maximum" });
  const match = reasoningFit({ reasoningEffort: "medium", reasoningDemand: "medium" });

  assert.equal(match.alignment, 0, "matching the demand is the baseline expectation");
  assert.ok(over.alignment < 0);
  assert.ok(under.alignment < 0);
  // Over-reasoning's cost is already counted in the cost term; under-reasoning's
  // harm (failing the task) appears nowhere else, so it must carry more weight
  // per unit of mismatch.
  const mildOver = reasoningFit({ reasoningEffort: "high", reasoningDemand: "medium" });
  const mildUnder = reasoningFit({ reasoningEffort: "low", reasoningDemand: "high" });
  assert.ok(
    Math.abs(mildUnder.alignment) > Math.abs(mildOver.alignment),
    "a comparable shortfall must outweigh a comparable excess"
  );
});

// ============================================================ 17/18. priority

test("18. Balanced is the default routing priority", () => {
  assert.equal(DEFAULT_ROUTING_PRIORITY, "balanced");
  assert.equal(defaultConfig.routing.priority, "balanced");
  assert.equal(normalizeRoutingPriority(undefined), "balanced");
  assert.equal(normalizeRoutingPriority("nonsense"), "balanced", "an unknown value falls back to the default, never to a random preset");
});

test("17. a routing priority alters only documented utility weights", () => {
  const documented = new Set([
    "qualityScale",
    "resourceCostScale",
    "latencyPenaltyScale",
    "quotaScarcityScale",
    "uncertaintyScale",
    "reasoningFitScale",
    "providerPreferenceScale"
  ]);
  for (const priority of ROUTING_PRIORITIES) {
    const weights = resolveUtilityWeights(priority);
    for (const key of Object.keys(weights)) {
      assert.ok(documented.has(key), `${priority} must not introduce an undocumented weight (${key})`);
    }
    assert.equal(weights.providerPreferenceScale, 3);
  }
  // Balanced is the baseline, unchanged from the exported weights.
  const balanced = resolveUtilityWeights("balanced");
  for (const key of Object.keys(balanced)) {
    if (key === "providerPreferenceScale") continue;
    assert.equal(balanced[key], UTILITY_WEIGHTS[key], `balanced must not change ${key}`);
  }
});

test("17b. each preset moves the weights in the direction its label promises", () => {
  const balanced = resolveUtilityWeights("balanced");
  const quality = resolveUtilityWeights("quality");
  const cost = resolveUtilityWeights("cost");
  const speed = resolveUtilityWeights("speed");

  assert.ok(quality.qualityScale > balanced.qualityScale, "Best quality must weigh quality more");
  assert.ok(quality.resourceCostScale < balanced.resourceCostScale, "Best quality must tolerate more cost");

  assert.ok(cost.resourceCostScale > balanced.resourceCostScale, "Lower cost must penalize cost more");
  assert.ok(cost.quotaScarcityScale > balanced.quotaScarcityScale, "Lower cost must conserve allowance harder");
  assert.ok(cost.qualityScale > 0, "Lower cost must not zero out quality — capability minimums still apply");

  assert.ok(speed.latencyPenaltyScale > balanced.latencyPenaltyScale, "Faster must penalize latency more");
  assert.ok(speed.qualityScale >= balanced.qualityScale * 0.9, "Faster must not abandon quality");
});

test("17c. the resolved weights are inspectable read-only rather than editable", () => {
  const described = routingPriorityDescription("cost");
  assert.equal(described.priority, "cost");
  assert.ok(described.label);
  assert.ok(described.summary);
  assert.ok(described.multipliers);
  assert.ok(described.resolvedWeights);
  assert.ok(described.baselineWeights);
});

test("17d. a priority preset cannot rescue an inadmissible candidate", () => {
  const config = {
    routing: { priority: "cost" },
    providers: { claude: { enabled: true, type: "builtin", models: [] } },
    modelCatalog: { validationTtlHours: 24 }
  };
  const catalog = defaultCatalog();
  replaceProviderModels(catalog, "claude", [
    { modelId: "claude-sonnet-5", displayName: "s", state: "rejected", discoverySource: "cli_command" }
  ]);
  for (const priority of ROUTING_PRIORITIES) {
    const route = selectAutomaticRoute({
      config,
      statuses: {},
      catalog,
      telemetryStore: defaultTelemetryStore(),
      benchmarkRows: [],
      taskProfile: buildTaskProfile({ prompt: "implement a function", estimatedInputTokens: 100 }),
      settings: {},
      priority
    });
    assert.equal(route.winner, null, `${priority} must not admit a catalog-rejected model`);
  }
});

// ============================================================ 30-33. migration

function legacyConfig() {
  return {
    configVersion: 2,
    server: {
      host: "127.0.0.1",
      port: 4117,
      exposedModel: "paragon",
      apiKey: "super-secret-key",
      tailscaleHost: "atlas.tail1a5964.ts.net",
      tailscaleServePort: 9420,
      tailscaleFunnelPort: 10000,
      cursorBaseUrl: "https://atlas.tail1a5964.ts.net:10000/v1"
    },
    providers: {
      claude: { type: "builtin", enabled: true, command: "claude", model: "claude-opus-5", avatar: "/avatars/claude.webp", models: [{ id: "a" }] },
      lmstudio: { type: "http", enabled: true, baseUrl: "http://100.80.17.40:1235", apiKey: "provider-token", model: "gemma", models: [] }
    },
    routing: {
      defaultProvider: "codex",
      fallbackChain: ["codex", "claude"],
      taskRoutes: { code: "codex", debug: "claude", review: "codex", plan: "claude", explain: "cursor", docs: "claude", quick: "cursor" }
    },
    routingIntelligence: { enabled: true, mode: "shadow", shadowRecordLimit: 200, quotaScarcity: 0, maximumAttempts: 4, capabilityMappings: { "a/b": {} } },
    orchestration: { enabled: true, mode: "live" },
    integrations: { openrouterApiKey: "sk-or-secret" }
  };
}

test("31. migration removes every obsolete routing field", () => {
  assert.equal(needsRoutingSchemaMigration(legacyConfig()), true);
  const { config, removed, changed } = migrateRoutingSchema(legacyConfig());
  assert.equal(changed, true);
  assert.equal(config.configVersion, CONFIG_VERSION);

  assert.equal(config.routing.defaultProvider, undefined);
  assert.equal(config.routing.fallbackChain, undefined);
  assert.equal(config.routing.taskRoutes, undefined);
  assert.equal(config.routing.priority, "balanced");
  assert.equal(config.providers.claude.model, undefined);
  assert.equal(config.providers.lmstudio.model, undefined);
  assert.equal(config.routingIntelligence, undefined);

  // The old values are recorded rather than silently discarded.
  const paths = removed.map((r) => r.path);
  assert.ok(paths.includes("routing.taskRoutes"));
  assert.ok(paths.includes("routing.defaultProvider"));
  assert.ok(paths.includes("routing.fallbackChain"));
  assert.ok(paths.includes("providers.claude.model"));
  assert.ok(paths.includes("routingIntelligence.mode"));
});

test("31b. the seven task-provider mappings are removed, not translated into the new model", () => {
  const { config, removed } = migrateRoutingSchema(legacyConfig());
  const record = removed.find((r) => r.path === "routing.taskRoutes");
  assert.equal(Object.keys(record.previousValue).length, 7, "the old values are logged for the operator");
  // Nothing in the migrated config encodes a provider preference.
  const serialized = JSON.stringify(config.routing);
  assert.ok(!serialized.includes("codex"));
  assert.ok(!serialized.includes("claude"));
  assert.deepEqual(Object.keys(config.routing), ["priority"]);
});

test("32. migration preserves credentials, endpoints, provider state, avatars and Tailscale settings", () => {
  const before = legacyConfig();
  const { config } = migrateRoutingSchema(before);

  assert.equal(config.server.apiKey, "super-secret-key");
  assert.equal(config.server.tailscaleHost, "atlas.tail1a5964.ts.net");
  assert.equal(config.server.tailscaleServePort, 9420);
  assert.equal(config.server.tailscaleFunnelPort, 10000);
  assert.equal(config.server.cursorBaseUrl, "https://atlas.tail1a5964.ts.net:10000/v1");
  assert.equal(config.integrations.openrouterApiKey, "sk-or-secret");

  assert.equal(config.providers.lmstudio.apiKey, "provider-token");
  assert.equal(config.providers.lmstudio.baseUrl, "http://100.80.17.40:1235");
  assert.equal(config.providers.claude.enabled, true);
  assert.equal(config.providers.claude.command, "claude");
  assert.equal(config.providers.claude.avatar, "/avatars/claude.webp");
  assert.deepEqual(config.providers.claude.models, [{ id: "a" }]);
  assert.equal(config.orchestration.mode, "live");

  // Operator-reviewed routing tables are still used by the live engine, so they
  // carry across rather than being discarded.
  assert.deepEqual(config.automaticRouting.capabilityMappings, { "a/b": {} });
  assert.equal(config.automaticRouting.maximumAttempts, 4);
});

test("33. migration is idempotent, so a migrated config survives restart unchanged", () => {
  const { config: once } = migrateRoutingSchema(legacyConfig());
  assert.equal(needsRoutingSchemaMigration(once), false, "a migrated config must not re-migrate on the next boot");
  const { config: twice, changed } = migrateRoutingSchema(once);
  assert.equal(changed, false);
  assert.deepEqual(twice, once);
});

test("30. the store writes a timestamped backup before removing anything", async () => {
  // Exercised against a real temp data dir through the real write path.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paragon-migration-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    const raw = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    fs.writeFileSync(path.join(tmp, "data", "config.json"), raw, "utf8");

    // Fresh module instance so `dataDir` resolves to this cwd.
    const store = await import(`../src/configStore.js?migration=${Date.now()}`);
    const config = await store.readConfig();

    assert.equal(config.configVersion, CONFIG_VERSION);
    assert.equal(config.routing.taskRoutes, undefined);

    const backups = fs.readdirSync(path.join(tmp, "data")).filter((f) => f.startsWith("config.backup."));
    assert.equal(backups.length, 1, "exactly one timestamped backup must be written");
    assert.equal(fs.readFileSync(path.join(tmp, "data", backups[0]), "utf8"), raw, "the backup must be the original file, byte for byte");
    // The rollback point still contains everything the migration removed.
    const restored = JSON.parse(fs.readFileSync(path.join(tmp, "data", backups[0]), "utf8"));
    assert.equal(restored.routing.taskRoutes.code, "codex");
    assert.equal(restored.providers.claude.model, "claude-opus-5");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("31c. the write path refuses to persist a removed field a client posts back", () => {
  const posted = { ...defaultConfig, routing: { priority: "balanced", taskRoutes: { code: "codex" } } };
  const { config } = migrateRoutingSchema(posted);
  assert.equal(config.routing.taskRoutes, undefined);
});
