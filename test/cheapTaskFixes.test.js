import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyProviderRunResult, providerResultError } from "../src/smartRoute/providerResult.js";
import { inferTaskTypeFromPrompt, applyTaskTypeHint } from "../src/smartRoute/taskHints.js";
import { selectSafeCheapProvider, isSafeCheapTask } from "../src/smartRoute/safeCheapTasks.js";
import { logRoutingDecision } from "../src/smartRoute/decisionLog.js";
import { readConfig, writeConfig } from "../src/configStore.js";
import { PROMPTS } from "../scripts/cheap-task-trial-prompts.js";
import { routeRequest } from "../src/smartRoute/route.js";
import { PATHS, writeCurrentSnapshot } from "../src/smartRoute/modelSnapshotStore.js";
import { invalidateRegistryCache } from "../src/smartRoute/registry.js";
import { cache, clearProviderHealthCache } from "../src/smartRoute/providerHealthCache.js";

const antigravityEntry = {
  id: "antigravity:flash",
  provider: "antigravity",
  model: "flash",
  tier: "cheap",
  routing: { priority: 40 }
};

const cursorEntry = {
  id: "cursor:sonnet",
  provider: "cursor",
  model: "sonnet-4",
  tier: "mid",
  routing: { priority: 60 }
};

const cheapCursorEntry = {
  id: "cursor:cheap",
  provider: "cursor",
  model: "cheap-model",
  tier: "cheap",
  routing: { priority: 55 }
};

const claudeEntry = {
  id: "claude:opus",
  provider: "claude",
  model: "",
  tier: "premium",
  routing: { priority: 70 }
};

const baseConfig = {
  routing: { smartRoute: { balanced: { safeCheapTasks: {} } } },
  providers: {
    antigravity: { enabled: true },
    cursor: { enabled: true },
    claude: { enabled: true }
  }
};

test("classifyProviderRunResult marks empty stdout as unhealthy", () => {
  const check = classifyProviderRunResult({ stdout: "", stderr: "", code: 0 }, null);
  assert.equal(check.ok, false);
  assert.equal(check.failure_category, "empty_stdout");
  assert.ok(check.metadata);
});

test("classifyProviderRunResult accepts non-empty stdout", () => {
  const check = classifyProviderRunResult({ stdout: "provider-check-ok", stderr: "", code: 0 }, null);
  assert.equal(check.ok, true);
});

test("providerResultError carries failure category", () => {
  const check = classifyProviderRunResult({ stdout: "", stderr: "", code: 0 }, null);
  const error = providerResultError("antigravity", check);
  assert.equal(error.providerFailureCategory, "empty_stdout");
});

test("cheap-task trial prompts classify with deterministic hints", () => {
  for (const prompt of PROMPTS) {
    const hinted = inferTaskTypeFromPrompt(prompt.message);
    if (prompt.id === "chat-2") {
      assert.equal(hinted, "math", `${prompt.id} should classify as math`);
    } else if (prompt.category === "chat") {
      assert.equal(hinted, null, `${prompt.id} should stay chat/default`);
    } else {
      assert.equal(hinted, prompt.category, `${prompt.id} expected ${prompt.category}, got ${hinted}`);
    }
  }
});

test("applyTaskTypeHint overrides classifier task_type for rewrite", () => {
  const decision = applyTaskTypeHint(
    { task_type: "chat", complexity: 2, risk: 1 },
    "Rewrite professionally: hey can u send the file asap"
  );
  assert.equal(decision.task_type, "rewrite");
});

test("safe cheap filter keeps selected when within tier ceiling", () => {
  const decision = { task_type: "rewrite", complexity: 2, risk: 1 };
  assert.ok(isSafeCheapTask(decision));
  const pick = selectSafeCheapProvider(cheapCursorEntry, [antigravityEntry, cheapCursorEntry], decision, baseConfig, {
    liveProviderHealth: { antigravity: { healthy: true } }
  });
  assert.equal(pick.selected.provider, "cursor");
  assert.equal(pick.reason, null);
});

test("safe cheap filter downgrades when tier above ceiling", () => {
  const decision = { task_type: "summarize", complexity: 2, risk: 1 };
  const pick = selectSafeCheapProvider(cursorEntry, [antigravityEntry, cheapCursorEntry, claudeEntry], decision, baseConfig, {
    liveProviderHealth: { antigravity: { healthy: true } }
  });
  assert.equal(pick.selected.tier, "cheap");
});

test("safe cheap filter does not prefer antigravity by name", () => {
  const decision = { task_type: "extract", complexity: 2, risk: 1 };
  const pick = selectSafeCheapProvider(cheapCursorEntry, [antigravityEntry, cheapCursorEntry], decision, baseConfig, {
    liveProviderHealth: { antigravity: { healthy: true } }
  });
  assert.equal(pick.selected.provider, "cursor");
});

test("safe cheap filter picks alternate within tier when selected fails filter", () => {
  const decision = { task_type: "chat", complexity: 1, risk: 1 };
  const pick = selectSafeCheapProvider(antigravityEntry, [antigravityEntry, cheapCursorEntry], decision, baseConfig, {
    liveProviderHealth: { antigravity: { healthy: false, failure_category: "empty_stdout" } }
  });
  assert.equal(pick.selected.provider, "cursor");
});

test("logRoutingDecision stores execution failure fields", async () => {
  const entry = await logRoutingDecision({
    mode: "balanced",
    execution_failed: true,
    final_error_category: "provider_error",
    final_error_summary: "all providers failed",
    attempted_providers: ["antigravity", "cursor"],
    no_response_reason: "empty_stdout",
    success: false
  });
  assert.equal(entry.execution_failed, true);
  assert.equal(entry.final_error_category, "provider_error");
  assert.deepEqual(entry.attempted_providers, ["antigravity", "cursor"]);
  assert.equal(entry.no_response_reason, "empty_stdout");
});

test("readConfig reflects on-disk config changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paragon-cfg-"));
  const prev = process.cwd();
  process.chdir(tmp);
  try {
    await fs.mkdir("data", { recursive: true });
    const initial = await readConfig();
    const next = {
      ...initial,
      routing: {
        ...initial.routing,
        smartRoute: {
          ...initial.routing.smartRoute,
          mode: "balanced"
        }
      }
    };
    await writeConfig(next);
    const reloaded = await readConfig();
    assert.equal(reloaded.routing.smartRoute.mode, "balanced");
  } finally {
    process.chdir(prev);
  }
});

test("active smartRoute mode uses model intelligence winner over antigravity", async () => {
  const { withIsolatedDataDir } = await import("./helpers/isolatedDataDir.js");
  await withIsolatedDataDir(async () => {
    await writeCurrentSnapshot({
      version: 1,
      stale: false,
      refresh_status: "ok",
      models: [
        {
          canonical_id: "antigravity:flash",
          provider: "antigravity",
          model: "flash",
          available: true,
          tier: "cheap",
          pricing: { input_per_1m: 1000, output_per_1m: 4000, pricing_source: "manual" },
          benchmarks: { benchmark_confidence: 0.5, paragon_eval: { rewrite: 0.5 } },
          health: { success_rate_24h: 0.95, healthy: true }
        },
        {
          canonical_id: "cursor:sonnet",
          provider: "cursor",
          model: "sonnet",
          available: true,
          tier: "mid",
          pricing: { input_per_1m: 0.01, output_per_1m: 0.04, pricing_source: "manual" },
          benchmarks: { benchmark_confidence: 0.9, paragon_eval: { rewrite: 0.95 } },
          health: { success_rate_24h: 0.98 }
        }
      ],
      rankings: {
        rewrite: [
          { canonical_id: "cursor:sonnet", rank: 1, provider: "cursor" },
          { canonical_id: "antigravity:flash", rank: 2, provider: "antigravity" }
        ]
      }
    });

    invalidateRegistryCache();
    cache.at = Date.now();
    cache.map = {
      antigravity: {
        healthy: true,
        response_ok: true,
        reachable: true,
        error: null,
        failure_category: null,
        latency_ms: 100
      }
    };

    try {
      const config = {
        routing: {
          smartRoute: {
            mode: "balanced",
            safeCheapTasks: {
              taskTypes: ["rewrite"],
              maxComplexity: 2,
              maxRisk: 2,
              maxTier: "cheap"
            }
          }
        },
        providers: {
          antigravity: { enabled: true },
          cursor: { enabled: true }
        }
      };

      const decision = await routeRequest(
        {
          model: "paragon",
          messages: [{ role: "user", content: "Rewrite this text please" }]
        },
        {},
        config
      );

      assert.equal(decision.provider, "cursor");
      assert.match(decision.gateReason ?? "", /model_intelligence:cursor:sonnet/);
      assert.equal(decision.uses_model_intelligence, true);
    } finally {
      clearProviderHealthCache();
      invalidateRegistryCache();
    }
  });
});
