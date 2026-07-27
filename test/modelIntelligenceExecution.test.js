import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { routeRequest } from "../src/smartRoute/route.js";
import { loadModelRegistry, invalidateRegistryCache } from "../src/smartRoute/registry.js";
import { buildSmartRouteAttempts } from "../src/smartRoute/safeCheapTasks.js";
import {
  checkExecutionMismatch,
  selectThroughModelIntelligence
} from "../src/smartRoute/intelligentSelection.js";
import { writeCurrentSnapshot } from "../src/smartRoute/modelSnapshotStore.js";
import { traceSelection } from "../src/smartRoute/traceSelection.js";

const haikuModel = {
  canonical_id: "claude:claude-haiku-4-5",
  provider: "claude",
  model: "claude-haiku-4-5",
  available: true,
  tier: "cheap",
  pricing: { input_per_1m: 0.8, output_per_1m: 4, pricing_source: "official_anthropic" },
  benchmarks: {
    benchmark_confidence: 0.9,
    routerbot_eval: { chat: 0.85, rewrite: 0.88, summarize: 0.9, extract: 0.87 }
  },
  health: { success_rate_24h: 0.98, response_ok: true },
  capabilities: { json_mode: true, tool_calling: true, context_tokens: 200000 }
};

const antigravityModel = {
  canonical_id: "antigravity:flash",
  provider: "antigravity",
  model: "flash",
  available: true,
  tier: "cheap",
  pricing: { input_per_1m: 0.1, output_per_1m: 0.2, pricing_source: "manual" },
  benchmarks: {
    benchmark_confidence: 0.5,
    routerbot_eval: { chat: 0.55, rewrite: 0.5, summarize: 0.52, extract: 0.5 }
  },
  health: {
    success_rate_24h: 0.5,
    response_ok: false,
    last_probe_status: "fail"
  },
  health_excluded: true,
  capabilities: { json_mode: true, context_tokens: 128000 }
};

function freshSnapshot(models) {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    stale: false,
    refresh_status: "ok",
    models
  };
}

const baseConfig = {
  routing: { smartRoute: { mode: "balanced" } },
  providers: {
    claude: { enabled: true, model: "claude-haiku-4-5" },
    antigravity: { enabled: true, model: "flash" },
    codex: { enabled: true, model: "gpt" }
  }
};

async function withIsolatedSnapshot(snapshot, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "routerbot-intel-"));
  const prevDataDir = process.env.SMARTROUTE_DATA_DIR;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.SMARTROUTE_DATA_DIR = tmp;
  process.env.NODE_ENV = "test";
  await fs.mkdir(tmp, { recursive: true });
  // Legacy fallback registry for stale-snapshot paths
  await fs.writeFile(
    path.join(tmp, "models.json"),
    `${JSON.stringify(
      [
        {
          id: "codex:default",
          provider: "codex",
          model: "default",
          enabled: true,
          tier: "mid",
          capabilities: {
            tool_calling: true,
            chat: true,
            json_mode: true,
            context_tokens: 200000
          }
        },
        {
          id: "claude:claude-haiku-4-5",
          provider: "claude",
          model: "claude-haiku-4-5",
          enabled: true,
          tier: "cheap",
          capabilities: {
            tool_calling: true,
            chat: true,
            json_mode: true,
            context_tokens: 200000
          }
        }
      ],
      null,
      2
    )}\n`
  );
  await writeCurrentSnapshot(snapshot);
  invalidateRegistryCache();
  try {
    return await fn();
  } finally {
    invalidateRegistryCache();
    if (prevDataDir === undefined) delete process.env.SMARTROUTE_DATA_DIR;
    else process.env.SMARTROUTE_DATA_DIR = prevDataDir;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
}

test("ranking winner claude-haiku executes claude-haiku in balanced mode", async () => {
  await withIsolatedSnapshot(freshSnapshot([haikuModel, antigravityModel]), async () => {
    const config = { ...baseConfig, routing: { smartRoute: { mode: "balanced" } } };
    const decision = await routeRequest(
      { messages: [{ role: "user", content: "rewrite this: hello world" }] },
      {},
      config
    );
    assert.equal(decision.uses_model_intelligence, true);
    assert.equal(decision.ranking_winner_canonical_id, "claude:claude-haiku-4-5");
    assert.equal(decision.selected_canonical_id, "claude:claude-haiku-4-5");
    assert.equal(decision.provider, "claude");
    assert.equal(decision.model, "claude-haiku-4-5");
  });
});

test("safeCheapTasks cannot replace ranking winner with antigravity", async () => {
  await withIsolatedSnapshot(freshSnapshot([haikuModel, antigravityModel]), async () => {
    const pick = await selectThroughModelIntelligence({
      taskType: "rewrite",
      features: {},
      config: baseConfig,
      candidates: []
    });
    assert.equal(pick.ranking_winner_canonical_id, "claude:claude-haiku-4-5");
    assert.equal(pick.selected_canonical_id, "claude:claude-haiku-4-5");
    assert.notEqual(pick.selected?.provider, "antigravity");
  });
});

test("data/models.json cannot override snapshot winner in balanced mode", async () => {
  await withIsolatedSnapshot(freshSnapshot([haikuModel, antigravityModel]), async () => {
    await fs.writeFile(
      path.join(process.env.SMARTROUTE_DATA_DIR, "models.json"),
      JSON.stringify([
        {
          id: "antigravity:flash",
          provider: "antigravity",
          model: "flash",
          tier: "cheap",
          enabled: true,
          routing: { priority: 99 }
        }
      ])
    );
    invalidateRegistryCache();

    const registry = await loadModelRegistry({
      ...baseConfig,
      routing: { smartRoute: { mode: "balanced" } }
    });
    const haiku = registry.find((r) => r.id === "claude:claude-haiku-4-5");
    const anti = registry.find((r) => r.id === "antigravity:flash");
    assert.ok(haiku, "snapshot haiku in registry");
    assert.ok(!anti || anti.routing?.priority !== 99, "models.json antigravity priority must not win");
  });
});

test("legacy provider executes only when snapshot stale in active mode", async () => {
  const stale = {
    ...freshSnapshot([haikuModel]),
    generated_at: new Date(Date.now() - 48 * 3_600_000).toISOString()
  };
  await withIsolatedSnapshot(stale, async () => {
    const decision = await routeRequest(
      { messages: [{ role: "user", content: "hello" }] },
      {},
      { ...baseConfig, routing: { smartRoute: { mode: "balanced" }, taskRoutes: { ask: "codex" } } }
    );
    assert.equal(decision.uses_model_intelligence, false);
    assert.match(decision.gateReason ?? "", /model_intelligence_stale/);
  });
});

test("execution mismatch is detected when final differs from ranking winner", () => {
  const mismatch = checkExecutionMismatch({
    usesIntelligence: true,
    ranking_winner_canonical_id: "claude:claude-haiku-4-5",
    final_executed_canonical_id: "antigravity:flash",
    total_fallback_used: false,
    execution_failed: false
  });
  assert.equal(mismatch.mismatch, true);
  assert.match(mismatch.reason, /antigravity/);
});

test("no mismatch when fallback used", () => {
  const ok = checkExecutionMismatch({
    usesIntelligence: true,
    ranking_winner_canonical_id: "claude:claude-haiku-4-5",
    final_executed_canonical_id: "antigravity:flash",
    total_fallback_used: true,
    execution_failed: false
  });
  assert.equal(ok.mismatch, false);
});

test("active mode blocks single-attempt chain to ranking winner", async () => {
  await withIsolatedSnapshot(freshSnapshot([haikuModel, antigravityModel]), async () => {
    const decision = await routeRequest(
      { messages: [{ role: "user", content: "summarize: a b c" }] },
      {},
      baseConfig
    );
    const registry = await loadModelRegistry(baseConfig);
    const attempts = buildSmartRouteAttempts({
      config: baseConfig,
      registry,
      primary: decision.provider,
      legacyProvider: "antigravity",
      smartDecision: decision,
      intelligenceActive: true
    });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].name, "claude");
    assert.equal(attempts[0].config.model, "claude-haiku-4-5");
    assert.equal(attempts[0].canonical_id, "claude:claude-haiku-4-5");
  });
});

test("trace-selection reports ranking winner as execution target", async () => {
  await withIsolatedSnapshot(freshSnapshot([haikuModel, antigravityModel]), async () => {
    const trace = await traceSelection("rewrite this: hello world", baseConfig);
    assert.equal(trace.ranking_winner, "claude:claude-haiku-4-5");
    assert.equal(trace.selected_canonical_id, "claude:claude-haiku-4-5");
    assert.equal(trace.final_attempted_provider, "claude");
  });
});
