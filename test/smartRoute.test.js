import assert from "node:assert/strict";
import test from "node:test";
import { parseClassifierResponse } from "../src/smartRoute/classifier.js";
import { filterCandidates, filterByClassifierDecision } from "../src/smartRoute/candidates.js";
import { cheapStaticDecision, extractFeatures } from "../src/smartRoute/features.js";
import { applyHardGates } from "../src/smartRoute/hardGates.js";
import { normalizeRequest } from "../src/smartRoute/normalize.js";
import { scoreAndSelect } from "../src/smartRoute/policyScorer.js";
import { resolveActiveProvider, isShadowMode, routeRequest } from "../src/smartRoute/route.js";
import { validateResponse, shouldEscalate } from "../src/smartRoute/validator.js";
import { defaultConfig } from "../src/defaultConfig.js";
import { writeCurrentSnapshot } from "../src/smartRoute/modelSnapshotStore.js";
import { withIsolatedDataDir } from "./helpers/isolatedDataDir.js";

const sampleRegistry = [
  {
    id: "cheap:one",
    provider: "antigravity",
    model: "flash",
    tier: "cheap",
    local: false,
    cost_input_per_1m: 0.1,
    cost_output_per_1m: 0.4,
    latency_class: "fast",
    reliability: 0.75,
    capabilities: {
      vision: true,
      tool_calling: true,
      json_mode: true,
      structured_output: true,
      reasoning: "medium",
      context_tokens: 100000
    },
    routing: { priority: 40, prefer_for: ["summarize"], avoid_for: ["high_stakes"] }
  },
  {
    id: "mid:one",
    provider: "codex",
    model: "",
    tier: "mid",
    local: false,
    cost_input_per_1m: 2,
    cost_output_per_1m: 8,
    latency_class: "medium",
    reliability: 0.85,
    capabilities: {
      vision: false,
      tool_calling: true,
      json_mode: true,
      structured_output: true,
      reasoning: "high",
      context_tokens: 128000
    },
    routing: { priority: 60, prefer_for: ["code"], avoid_for: [] }
  },
  {
    id: "premium:one",
    provider: "claude",
    model: "",
    tier: "premium",
    local: false,
    cost_input_per_1m: 5,
    cost_output_per_1m: 20,
    latency_class: "medium",
    reliability: 0.9,
    capabilities: {
      vision: false,
      tool_calling: true,
      json_mode: true,
      structured_output: true,
      reasoning: "high",
      context_tokens: 200000
    },
    routing: { priority: 70, prefer_for: ["architecture"], avoid_for: [] }
  }
];

const baseConfig = {
  ...defaultConfig,
  server: { ...defaultConfig.server, exposedModel: "paragon" },
  routing: {
    ...defaultConfig.routing,
    smartRoute: { ...defaultConfig.routing.smartRoute, mode: "shadow_test" }
  }
};

test("parseClassifierResponse accepts fenced JSON", () => {
  const decision = parseClassifierResponse(
    'Here is the result:\n{"task_type":"code_debug","complexity":4,"risk":2,"needs_tools":false,"needs_vision":false,"needs_long_context":false,"needs_strict_json":false,"privacy_level":"normal","recommended_tier":"mid","confidence":0.82,"reason":"debug"}'
  );
  assert.equal(decision.task_type, "code_debug");
  assert.equal(decision.complexity, 4);
  assert.equal(decision.recommended_tier, "mid");
});

test("applyHardGates routes vision to cheapest capable model", () => {
  const normalized = normalizeRequest(
    {
      model: "paragon",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }]
    },
    {},
    baseConfig
  );
  const gate = applyHardGates(normalized, sampleRegistry, {});
  assert.equal(gate.selected.provider, "antigravity");
  assert.equal(gate.source, "hard_gate");
});

test("applyHardGates routes tools to tool-capable model", () => {
  const normalized = normalizeRequest(
    {
      model: "paragon",
      messages: [{ role: "user", content: "run tool" }],
      tools: [{ type: "function", function: { name: "x" } }]
    },
    {},
    baseConfig
  );
  const gate = applyHardGates(normalized, sampleRegistry, {});
  assert.equal(gate.selected.capabilities.tool_calling, true);
});

test("extractFeatures marks obvious simple summarize prompts", () => {
  const normalized = normalizeRequest(
    {
      model: "paragon",
      messages: [{ role: "user", content: "Summarize this in one paragraph." }]
    },
    {},
    baseConfig
  );
  const features = extractFeatures(normalized);
  assert.equal(features.isObviousSimple, true);
  const decision = cheapStaticDecision(features);
  assert.equal(decision.task_type, "summarize");
  assert.ok(decision.recommended_tier === "cheap" || decision.recommended_tier === "local");
});

test("filterByClassifierDecision prefers recommended tier", () => {
  const filtered = filterByClassifierDecision(sampleRegistry, {
    task_type: "code",
    recommended_tier: "mid",
    complexity: 3
  });
  assert.ok(filtered.every((entry) => entry.tier !== "cheap"));
  assert.ok(filtered.some((entry) => entry.id === "mid:one"));
});

test("scoreAndSelect favors cost in cost_saver mode", () => {
  const decision = { recommended_tier: "premium", complexity: 5, task_type: "architecture" };
  const cheapPick = scoreAndSelect(sampleRegistry, decision, { mode: "cost_saver" });
  const qualityPick = scoreAndSelect(sampleRegistry, decision, { mode: "maximum_quality" });
  assert.equal(qualityPick.tier, "premium");
  assert.ok(cheapPick.cost_input_per_1m < qualityPick.cost_input_per_1m);
});

test("resolveActiveProvider keeps legacy route in shadow_test", () => {
  const smart = { provider: "antigravity" };
  assert.equal(resolveActiveProvider(smart, "codex", baseConfig), "codex");
  assert.equal(isShadowMode(baseConfig), true);
});

test("resolveActiveProvider sync helper ignores snapshot (execution uses resolveRoutingProvider)", () => {
  const config = {
    ...baseConfig,
    providers: { ...baseConfig.providers, antigravity: { ...baseConfig.providers.antigravity, enabled: true } },
    routing: {
      ...baseConfig.routing,
      smartRoute: { ...baseConfig.routing.smartRoute, mode: "balanced" }
    }
  };
  assert.equal(resolveActiveProvider({ provider: "antigravity" }, "codex", config), "antigravity");
});

test("validateResponse flags empty and invalid JSON", () => {
  assert.equal(validateResponse("", null, { requiresStrictJson: true }).result, "fail");
  assert.equal(validateResponse('{"ok":true}', null, { requiresStrictJson: true }).result, "pass");
});

test("validateResponse allows prose code_debug answers when complexity is low", () => {
  const result = validateResponse("The bug is a division by zero on empty input.", {
    task_type: "code_debug",
    complexity: 2,
    risk: 1
  });
  assert.equal(result.result, "pass");
  assert.equal(result.category, null);
});

test("validateResponse requires code shape for high-complexity code tasks", () => {
  const result = validateResponse("The bug is a division by zero.", {
    task_type: "code_debug",
    complexity: 4,
    risk: 2
  });
  assert.equal(result.result, "fail");
  assert.equal(result.category, "weak_answer");
});

test("shouldEscalate respects settings", () => {
  assert.equal(
    shouldEscalate({ result: "fail", issues: ["empty_response"] }, { confidence: 0.9 }, { escalationEnabled: true }),
    true
  );
  assert.equal(
    shouldEscalate({ result: "pass", issues: [] }, { confidence: 0.4 }, {
      escalationEnabled: true,
      confidenceThreshold: 0.55
    }),
    true
  );
  assert.equal(
    shouldEscalate({ result: "pass", issues: [] }, { confidence: 0.9 }, { escalationEnabled: false }),
    false
  );
});

test("routeRequest picks hard gate for tools without classifier", async () => {
  // routeRequest() resolves candidates from the live model registry
  // (src/smartRoute/registry.js -> readCurrentSnapshot), not from the
  // sampleRegistry fixture above used by the direct applyHardGates() unit
  // tests — without a written snapshot the registry is empty and the tool
  // hard gate has nothing to select, so this needs its own seeded snapshot.
  await withIsolatedDataDir(async () => {
    await writeCurrentSnapshot({
      version: 1,
      stale: false,
      refresh_status: "ok",
      models: [
        { canonical_id: "codex:default", provider: "codex", model: "default", available: true }
      ]
    });

    const config = {
      ...baseConfig,
      providers: {
        codex: { ...baseConfig.providers.codex, enabled: true },
        antigravity: { ...baseConfig.providers.antigravity, enabled: true },
        claude: { ...baseConfig.providers.claude, enabled: true }
      }
    };

    const decision = await routeRequest(
      {
        model: "paragon",
        messages: [{ role: "user", content: "use my tool" }],
        tools: [{ type: "function", function: { name: "lookup" } }]
      },
      {},
      config
    );

    assert.equal(decision.source, "hard_gate");
    assert.equal(decision.gateReason, "tools_required");
    assert.ok(decision.provider);
  });
});

test("filterCandidates excludes non-tool models when tools required", () => {
  const features = {
    requiresTools: true,
    hasImage: false,
    requiresStrictJson: false,
    estimatedTokens: 100
  };
  const candidates = filterCandidates(
    [
      ...sampleRegistry,
      {
        id: "local:one",
        provider: "ollama-local",
        tier: "local",
        local: true,
        capabilities: { tool_calling: false, context_tokens: 8192 },
        routing: {}
      }
    ],
    features,
    {}
  );
  assert.ok(candidates.every((entry) => entry.capabilities.tool_calling));
});
