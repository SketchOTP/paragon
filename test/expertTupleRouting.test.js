import assert from "node:assert/strict";
import test from "node:test";
import { buildAttemptPlan } from "../src/routing/attemptPlan.js";
import { executionMethodFor, expertTupleId } from "../src/routing/expertTuple.js";
import { rankCandidates } from "../src/routing/expectedUtility.js";
import { buildTaskProfile } from "../src/routing/taskProfile.js";

const config = {
  providers: {
    claude: { enabled: true, type: "builtin", model: "fallback" },
    openrouter: { enabled: true, type: "http", model: "fallback" }
  }
};

test("attempt plans preserve complete expert tuple identity", () => {
  const ranked = [
    {
      provider: "claude",
      providerModelId: "sonnet-4.6",
      canonicalModelId: "sonnet-4.6",
      executionProfile: "effort:high",
      reasoningProfile: "high",
      executionMethod: "native_agent_cli",
      executionPath: "native-agent-cli",
      expertId: expertTupleId({ provider: "claude", canonicalModelId: "sonnet-4.6", reasoningProfile: "high", executionMethod: "native_agent_cli" }),
      excluded: false
    },
    {
      provider: "claude",
      providerModelId: "sonnet-4.5",
      canonicalModelId: "sonnet-4.5",
      executionProfile: "effort:medium",
      reasoningProfile: "medium",
      executionMethod: "native_agent_cli",
      executionPath: "native-agent-cli",
      expertId: expertTupleId({ provider: "claude", canonicalModelId: "sonnet-4.5", reasoningProfile: "medium", executionMethod: "native_agent_cli" }),
      excluded: false
    },
    {
      provider: "openrouter",
      providerModelId: "qwen-coder",
      canonicalModelId: "qwen-coder",
      executionProfile: "effort:medium",
      reasoningProfile: "medium",
      executionMethod: "openai_compatible_http",
      executionPath: "openai-compatible-http",
      expertId: expertTupleId({ provider: "openrouter", canonicalModelId: "qwen-coder", reasoningProfile: "medium", executionMethod: "openai_compatible_http" }),
      excluded: false
    }
  ];
  const plan = buildAttemptPlan(ranked, config, { maximumAttempts: 3, maxPerProvider: 2 });
  assert.equal(plan[0].config.model, "sonnet-4.6");
  assert.equal(plan[0].reasoningProfile, "high");
  assert.equal(plan[0].executionMethod, "native_agent_cli");
  assert.equal(plan[1].config.model, "sonnet-4.5");
  assert.equal(plan[2].executionMethod, "openai_compatible_http");
  assert.notEqual(plan[0].expertId, plan[1].expertId);
});

test("execution method mapping distinguishes native CLI and HTTP experts", () => {
  assert.equal(executionMethodFor("claude", false), "native_agent_cli");
  assert.equal(executionMethodFor("openrouter", true), "openai_compatible_http");
});

test("ranking preserves HTTP execution identity into the attempt plan", () => {
  const taskProfile = buildTaskProfile({ prompt: "Use tools to create a workspace file", estimatedInputTokens: 20 });
  const candidate = {
    provider: "openrouter",
    providerModelId: "qwen/qwen3-coder",
    catalogEligible: true,
    health: "healthy",
    isHttpProvider: true,
    executionMethod: "openai_compatible_http",
    executionPath: "openai-compatible-http",
    expertId: expertTupleId({ provider: "openrouter", canonicalModelId: "qwen/qwen3-coder", reasoningProfile: "medium", executionMethod: "openai_compatible_http" }),
    executionProfile: { canonicalModelId: "qwen/qwen3-coder", reasoningEffort: "medium", speedMode: "unknown", executionProfile: "effort:medium" },
    capabilities: { chatCompletions: true, streaming: true, toolExecution: true, openAIToolCalls: true, structuredOutput: "unknown" },
    contextModel: { effectiveUsableContextWindow: 200000, contextConfidence: "high", outputTokenReserve: 4096 },
    telemetry: null,
    benchmark: null,
    costClass: "standard"
  };
  const result = rankCandidates([candidate], { taskProfile, unknownLargeContextThresholdTokens: 50000 });
  assert.equal(result.ranked[0].executionMethod, "openai_compatible_http");
  assert.equal(result.ranked[0].executionPath, "openai-compatible-http");
  assert.equal(result.ranked[0].expertId, candidate.expertId);
  const plan = buildAttemptPlan(result.ranked, { providers: { openrouter: { enabled: true, type: "http" } } });
  assert.equal(plan[0].reasoningProfile, "medium");
  assert.equal(plan[0].config.reasoningProfile, "medium");
});
