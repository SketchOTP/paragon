import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildTaskProfileV2 } from "../src/routing/taskProfileV2.js";
import { sufficiencyThreshold, applySufficiencyPolicy } from "../src/routing/sufficiencyPolicy.js";
import { confidenceAdjustedProbability, estimateSuccessProbability } from "../src/routing/successProbability.js";
import { estimateTaskCost, costPerSuccessfulTask } from "../src/routing/taskCost.js";
import { evaluatePlan, optimizeFallbackPlan } from "../src/routing/planOptimizer.js";
import { createArtificialAnalysisClient } from "../src/routing/evidence/artificialAnalysisClient.js";
import { createEvidenceStore, evidenceRecord, usableEvidence } from "../src/routing/evidence/evidenceStore.js";
import { fuseEvidence } from "../src/routing/evidence/evidenceFusion.js";
import { validateEvaluationArtifact, availabilityAcceptanceProbe, summarizeEvaluation } from "../src/routing/internalEvaluation.js";
import { getCachedBenchmarkData } from "../src/routing/benchmarks.js";
import { rankCandidates } from "../src/routing/expectedUtility.js";

const headers = (values = {}) => ({ get: (name) => values[name.toLowerCase()] ?? null });
const response = (body, values = {}, ok = true, status = 200) => ({ ok, status, headers: headers(values), json: async () => body });

test("TaskProfileV2 distinguishes repository agent work from a self-contained function", () => {
  const repo = buildTaskProfileV2({ prompt: "Debug and patch the repository, run tests, and inspect the production regression", body: { tools: [{}] }, estimatedInputTokens: 70000 });
  const fn = buildTaskProfileV2({ prompt: "write a small self-contained function" });
  assert.equal(repo.repositoryEditingRequired, true);
  assert.equal(repo.agenticIntensity, "high");
  assert.equal(repo.contextRequirement, "large");
  assert.equal(fn.repositoryEditingRequired, false);
  assert.equal(fn.agenticIntensity, "none");
});

test("sufficiency thresholds increase with task risk and complexity", () => {
  assert.equal(sufficiencyThreshold({ risk: "low", complexity: "trivial" }), 0.78);
  assert.equal(sufficiencyThreshold({ risk: "normal", complexity: "complex" }), 0.91);
  assert.equal(sufficiencyThreshold({ risk: "production", complexity: "normal" }), 0.94);
  assert.equal(sufficiencyThreshold({ risk: "security_critical", complexity: "extreme" }), 0.97);
});

test("confidence lower bound shrinks sparse lucky evidence", () => {
  assert.ok(confidenceAdjustedProbability({ successes: 1, attempts: 1 }) < 1);
  assert.ok(confidenceAdjustedProbability({ successes: 90, attempts: 100 }) > confidenceAdjustedProbability({ successes: 1, attempts: 1 }));
});

test("success prediction exposes insufficient and satisfactory states", () => {
  const weak = estimateSuccessProbability({ taskProfile: { risk: "complex", complexity: "complex" }, exact: { successes: 1, attempts: 10 } });
  const strong = estimateSuccessProbability({ taskProfile: { risk: "complex", complexity: "complex" }, exact: { successes: 99, attempts: 100 } });
  assert.equal(weak.sufficient, false);
  assert.equal(strong.sufficient, true);
  assert.equal(strong.source, "exact_tuple");
});

test("task cost preserves independently denominated resources", () => {
  const cost = estimateTaskCost({ inputTokens: 100, answerTokens: 200, reasoningTokens: 50, pricing: { inputPerToken: 0.01, outputPerToken: 0.02, reasoningPerToken: 0.02 }, credits: 4, quotaFraction: 0.1, latencyMs: 500, remaining: { usd: 100, credits: 100, allowance: 1 } });
  assert.equal(cost.usd, 6);
  assert.equal(cost.credits, 4);
  assert.equal(cost.quotaFraction, 0.1);
  assert.equal(cost.latencyMs, 500);
  assert.equal(costPerSuccessfulTask(cost, 0.5).costPerSuccessfulTask, cost.normalizedBurden / 0.5);
});

test("plan cost uses conditional retry probability", () => {
  const plan = [{ provider: "a", cost: 2, successProbability: 0.5 }, { provider: "b", cost: 10, successProbability: 0.9 }];
  const result = evaluatePlan(plan, { attemptCost: (x) => x.cost, failureProbability: (x) => 1 - x.successProbability });
  assert.equal(result.expectedCost, 7);
  assert.equal(result.successProbability, 0.95);
});

test("optimizer selects cheap-first when its expected cumulative cost is lower", () => {
  const result = optimizeFallbackPlan([{ provider: "cheap", providerModelId: "c", cost: 1, successProbability: 0.9 }, { provider: "strong", providerModelId: "s", cost: 10, successProbability: 0.99 }], { maximumAttempts: 2, minimumAttempts: 2, successTarget: 0.999, attemptCost: (x) => x.cost, failureProbability: (x) => 1 - x.successProbability });
  assert.deepEqual(result.plan.map((x) => x.provider), ["cheap", "strong"]);
});

test("optimizer can select strong-first when cheap-first has excessive failure risk", () => {
  const result = optimizeFallbackPlan([{ provider: "cheap", providerModelId: "c", cost: 1, successProbability: 0.2 }, { provider: "strong", providerModelId: "s", cost: 4, successProbability: 0.99 }], { maximumAttempts: 2, minimumAttempts: 2, successTarget: 0.999, attemptCost: (x) => x.cost, failureProbability: (x) => 1 - x.successProbability });
  assert.deepEqual(result.plan.map((x) => x.provider), ["strong", "cheap"]);
});

test("optimizer search is bounded for a large production catalog", () => {
  const candidates = Array.from({ length: 100 }, (_, index) => ({ provider: `p${index}`, providerModelId: `m${index}`, cost: index + 1, successProbability: 0.9 }));
  const started = Date.now();
  const result = optimizeFallbackPlan(candidates, { maximumAttempts: 4, minimumAttempts: 2, searchBudget: 250, attemptCost: (x) => x.cost, failureProbability: (x) => 1 - x.successProbability });
  assert.ok(Date.now() - started < 1000);
  assert.ok(result.visited <= 250);
});

test("production optimizer can pin the ranked winner as the first attempt", () => {
  const result = optimizeFallbackPlan(
    [
      { provider: "ranked", providerModelId: "winner", cost: 100, successProbability: 0.5 },
      { provider: "cheap", providerModelId: "alternate", cost: 1, successProbability: 0.99 }
    ],
    { maximumAttempts: 2, minimumAttempts: 2, pinFirst: true, successTarget: 0.999, attemptCost: (x) => x.cost, failureProbability: (x) => 1 - x.successProbability }
  );
  assert.deepEqual(result.plan.map((x) => x.provider), ["ranked", "cheap"]);
});

test("provider-wide failure is represented as correlated failure", () => {
  const result = evaluatePlan([{ provider: "broken", providerModelId: "a", cost: 1, successProbability: 0.9 }, { provider: "broken", providerModelId: "b", cost: 1, successProbability: 0.9 }, { provider: "other", providerModelId: "c", cost: 2, successProbability: 0.9 }], { providerFailureProbability: (x) => x.provider === "broken" ? 1 : 0, attemptCost: (x) => x.cost });
  assert.deepEqual(result.providersWithCorrelatedFailure, ["broken"]);
  assert.equal(result.expectedCost, 3);
});

test("Artificial Analysis client paginates and returns tier and rate-limit metadata", async () => {
  let calls = 0;
  const client = createArtificialAnalysisClient({ apiKey: "server-only", fetchImpl: async (url) => { calls++; return calls === 1 ? response({ tier: "pro", data: [{ id: "aa-1" }], next_cursor: "next" }, { "x-ratelimit-remaining": "99", "x-ratelimit-reset": "123" }) : response({ tier: "pro", data: [{ id: "aa-2" }] }, { "x-ratelimit-remaining": "98", "x-ratelimit-reset": "124" }); } });
  const result = await client.fetchModels({ tier: "free" });
  assert.equal(calls, 2);
  assert.equal(result.tier, "pro");
  assert.deepEqual(result.rows.map((x) => x.id), ["aa-1", "aa-2"]);
  assert.equal(result.rateLimitRemaining, "98");
  assert.equal(result.rateLimitReset, "124");
});

for (const [status, kind] of [[401, "invalid_credentials"], [403, "forbidden"], [429, "rate_limited"]]) {
  test(`Artificial Analysis classifies HTTP ${status}`, async () => {
    const client = createArtificialAnalysisClient({ apiKey: "secret", fetchImpl: async () => response({}, { "retry-after": "30" }, false, status) });
    await assert.rejects(client.fetchModels(), (error) => error.status === status && error.kind === kind && (status !== 429 || error.retryAfter === "30"));
  });
}

test("evidence records are hashed, attributable, and stale records are withheld", () => {
  const record = evidenceRecord({ source: "artificial_analysis", sourceRecordId: "aa-1", canonicalModelId: "model", metric: "coding_index", value: 80, observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), attributionRequired: true, raw: { id: "aa-1" } });
  assert.match(record.rawRecordHash, /^[a-f0-9]{64}$/);
  assert.equal(record.attributionRequired, true);
  assert.equal(usableEvidence([record]).length, 1);
  assert.equal(usableEvidence([{ ...record, fetchedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString() }]).length, 0);
});

test("evidence store replacement is atomic at the file boundary", async () => {
  const store = createEvidenceStore({ filePath: `/tmp/paragon-evidence-${process.pid}.json` });
  store.replace([evidenceRecord({ source: "test", sourceRecordId: "1", canonicalModelId: "m", metric: "x", value: 1 })]);
  await store.save();
  await store.load();
  assert.equal(store.snapshot().records.length, 1);
});

test("evidence fusion prefers exact tuple over external priors", () => {
  const result = fuseEvidence({ taskProfile: { workType: "code" }, exactTuple: { source: "exact_tuple", coding_index: 91 }, artificialAnalysis: { source: "artificial_analysis", coding_index: 80 } });
  assert.equal(result.value, 91);
  assert.equal(result.source, "exact_tuple");
});

test("internal evaluation is separate from availability acceptance", () => {
  assert.equal(availabilityAcceptanceProbe("ok").kind, "availability_acceptance_probe");
  assert.equal(validateEvaluationArtifact({ family: "json_schema", output: '{"x":1}', schema: { required: ["x"] } }).passed, true);
  assert.equal(validateEvaluationArtifact({ family: "json_schema", output: '{}', schema: { required: ["x"] } }).passed, false);
  assert.deepEqual(summarizeEvaluation([{ passed: true }, { passed: false }]), { attempts: 2, successes: 1, firstPassRate: 0.5, eventualPassRate: 0.5 });
});

test("cached benchmark reads never invoke fetch", () => {
  const result = getCachedBenchmarkData("some-key");
  assert.equal(result.stale, true);
  assert.deepEqual(result.rows, []);
});

test("zero provider preference has exactly zero term", () => {
  const candidate = { provider: "zero", providerModelId: "m", catalogEligible: true, health: "healthy", executionProfile: { reasoningEffort: "low", speedMode: "standard", canonicalModelId: "m" }, capabilities: { chatCompletions: true }, contextModel: { effectiveUsableContextWindow: 100000, contextConfidence: "high", outputTokenReserve: 100 }, publishedPricing: { inputPerMillion: 1, completionPerMillion: 1, billingUnit: "USD per 1M tokens" } };
  const result = rankCandidates([candidate], { taskProfile: { risk: "low", complexity: "trivial", workType: "quick", reasoningDemand: "minimal", estimatedInputTokens: 10 }, providerPreferencePoints: { zero: 0 }, providerPreferenceScale: 100 });
  assert.equal(result.winner.components.providerPreferenceTerm, 0);
});

test("sufficiency policy labels degraded routing", () => {
  assert.deepEqual(applySufficiencyPolicy(0.7, { risk: "production" }), { threshold: 0.94, probability: 0.7, sufficient: false, route: "degraded_sufficiency" });
});

test("settings UI exposes both evidence keys as password inputs", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="setting-openrouter-key" type="password"/);
  assert.match(html, /id="setting-artificial-analysis-key" type="password"/);
  assert.equal((html.match(/id="save-settings"/g) ?? []).length, 1);
});

test("settings UI preserves masked keys and provides explicit OpenRouter removal", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /openrouterApiKeyConfigured/);
  assert.match(app, /\/api\/integrations\/openrouter\/remove/);
  assert.match(app, /if \(artificialAnalysisApiKey \|\| openRouterApiKey\)/);
});

test("server settings update ignores empty OpenRouter submissions", () => {
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /if \(value\) integrations\.openrouterApiKey = value/);
  assert.match(server, /app\.post\("\/api\/integrations\/openrouter\/remove"/);
});

test("product settings never serializes the raw OpenRouter key", () => {
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const productSettingsSection = server.slice(server.indexOf("function productSettings"), server.indexOf('app.get("/api/settings"'));
  assert.doesNotMatch(productSettingsSection, /openrouterApiKey:/);
  assert.match(productSettingsSection, /openrouterApiKeyConfigured/);
});

test("integration key removal is explicit for both evidence sources", () => {
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /\/api\/integrations\/openrouter\/remove/);
  assert.match(server, /\/api\/integrations\/artificial-analysis\/remove/);
});
