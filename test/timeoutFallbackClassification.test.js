import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIntelligenceAttempts,
  buildTimeoutAudit,
  mergeExecutionConfig
} from "../src/smartRoute/executionPolicy.js";
import { buildSmartRouteAttempts } from "../src/smartRoute/safeCheapTasks.js";
import {
  applyTaskTypeHint,
  inferHardTaskTypeFromPrompt,
  inferTaskTypeFromPrompt
} from "../src/smartRoute/taskHints.js";
import { isCostFloorTask, getCheapTaskOptimization } from "../src/smartRoute/optimization.js";
import { resolveSelectionStrategy, resolveTaskFloor } from "../src/smartRoute/modelRanker.js";

const flash = {
  id: "antigravity:Gemini 3.5 Flash (High)",
  provider: "antigravity",
  model: "Gemini 3.5 Flash (High)",
  tier: "cheap",
  pricing: { input_per_1m: 0.1, output_per_1m: 0.4 }
};

const haiku = {
  id: "claude:claude-haiku-4-5",
  provider: "claude",
  model: "claude-haiku-4-5",
  tier: "cheap",
  pricing: { input_per_1m: 0.8, output_per_1m: 4 }
};

const opus = {
  id: "claude:claude-opus-4-6",
  provider: "claude",
  model: "claude-opus-4-6",
  tier: "premium",
  pricing: { input_per_1m: 15, output_per_1m: 75 }
};

const registry = [flash, haiku, opus];

const config = {
  providers: {
    antigravity: { enabled: true, model: "Gemini 3.5 Flash (High)", timeoutMs: 300000 },
    claude: { enabled: true, model: "claude-opus-4-6", timeoutMs: 300000 }
  },
  routing: {
    smartRoute: {
      execution: {
        providerTimeoutMs: 90000,
        retrySameProviderOnTimeout: false,
        fallbackOnProviderTimeout: true,
        maxProviderAttempts: 3
      },
      balanced: {
        safeCheapTasks: {
          maxTier: "cheap"
        }
      }
    }
  }
};

test("summarize timeout falls back to next ranked floor-passing candidate", () => {
  const smartDecision = {
    task_type: "summarize",
    complexity: 2,
    risk: 1,
    selected_canonical_id: flash.id,
    ranking_winner_canonical_id: flash.id,
    selected: flash,
    ranked_fallback_ids: [haiku.id, opus.id],
    candidates: [flash.id, haiku.id, opus.id]
  };

  const built = buildIntelligenceAttempts({
    config,
    registry,
    primary: "antigravity",
    legacyProvider: "antigravity",
    smartDecision,
    isSafeCheap: true,
    maxTier: "cheap"
  });

  assert.ok(built.attempts.length >= 2);
  assert.equal(built.attempts[0].canonical_id, flash.id);
  assert.equal(built.attempts[1].canonical_id, haiku.id);
  assert.equal(built.attempts[0].config.timeoutMs, 90000);
  assert.ok(built.fallback_candidate_count >= 1);
  // Does not jump straight to premium when a cheap floor-passer exists.
  assert.notEqual(built.attempts[1].canonical_id, opus.id);
});

test("timeout never leaves final_executed null if fallback exists", () => {
  const smartDecision = {
    task_type: "summarize",
    complexity: 1,
    risk: 1,
    selected_canonical_id: flash.id,
    ranking_winner_canonical_id: flash.id,
    selected: flash,
    ranked_fallback_ids: [haiku.id],
    candidates: [flash.id, haiku.id]
  };

  const attempts = buildSmartRouteAttempts({
    config,
    registry,
    primary: "antigravity",
    legacyProvider: "codex",
    smartDecision,
    intelligenceActive: true
  });

  assert.ok(attempts.length >= 2, "must have fallback attempt");
  assert.equal(attempts[0].name, "antigravity");
  assert.equal(attempts[1].name, "claude");
  assert.ok(attempts.fallback_candidate_count >= 1);
});

test("provider timeout logs fallback_block_reason when no fallback", () => {
  const attempts = [
    {
      name: "antigravity",
      config: { model: "flash", timeoutMs: 90000 },
      canonical_id: flash.id
    }
  ];
  attempts.fallback_candidate_count = 0;
  attempts.fallback_block_reason = "no_fallback_candidates";

  const audit = buildTimeoutAudit({
    attempts,
    failedAttempt: attempts[0],
    timeoutMs: 90000,
    providerFallbackUsed: false,
    fallbackCandidateCount: 0,
    fallbackBlockReason: "no_fallback_candidates"
  });

  assert.equal(audit.timeout_ms, 90000);
  assert.equal(audit.attempted_canonical_id, flash.id);
  assert.equal(audit.attempted_provider, "antigravity");
  assert.equal(audit.attempted_model, "flash");
  assert.equal(audit.fallback_candidate_count, 0);
  assert.equal(audit.fallback_attempted, false);
  assert.equal(audit.fallback_block_reason, "no_fallback_candidates");
});

test("code_debug prompt cannot classify as chat", () => {
  const prompts = [
    "Debug this Python bug and explain the fix: def avg(xs): return sum(xs)/len(xs)",
    "Find the bug in this code and propose a fix: for i in range(len(items)): items.pop(i)",
    "Why does this code throw a TypeError on empty input?"
  ];
  for (const prompt of prompts) {
    assert.equal(inferHardTaskTypeFromPrompt(prompt), "code_debug", prompt);
    assert.equal(inferTaskTypeFromPrompt(prompt), "code_debug", prompt);
    const decision = applyTaskTypeHint(
      { task_type: "chat", complexity: 1, risk: 1, reason: "llm said chat" },
      prompt
    );
    assert.equal(decision.task_type, "code_debug");
    assert.ok(decision.complexity >= 3);
  }
});

test("architecture prompt cannot classify as chat", () => {
  const prompts = [
    "Plan a microservices architecture for a multi-tenant billing system.",
    "Design a system architecture for real-time collaborative document editing.",
    "Write a technical plan and project structure for the router design."
  ];
  for (const prompt of prompts) {
    assert.equal(inferHardTaskTypeFromPrompt(prompt), "architecture", prompt);
    const decision = applyTaskTypeHint(
      { task_type: "chat", complexity: 2, risk: 1, reason: "llm said chat" },
      prompt
    );
    assert.equal(decision.task_type, "architecture");
    assert.ok(decision.complexity >= 4);
  }
});

test("high-complexity chat does not use cheap-task optimizer", () => {
  const cheap = getCheapTaskOptimization({ mode: "balanced" }, "balanced");
  assert.equal(
    isCostFloorTask("chat", { complexity: 5, risk: 1, cheapTaskConfig: cheap }),
    false
  );
  assert.equal(
    isCostFloorTask("chat", { complexity: 2, risk: 1, cheapTaskConfig: cheap }),
    true
  );

  const strategy = resolveSelectionStrategy("chat", {
    complexity: 5,
    risk: 1,
    cheapTaskConfig: cheap
  });
  assert.notEqual(strategy, "min_cost_above_floor");

  const floor = resolveTaskFloor("chat", { complexity: 5, cheapTaskConfig: cheap });
  assert.ok(floor.min_quality >= 0.55);
});

test("safe cheap timeout does not escalate directly to premium unless no cheaper floor-passing candidate exists", () => {
  const withCheapFallback = buildIntelligenceAttempts({
    config,
    registry,
    primary: "antigravity",
    legacyProvider: "antigravity",
    smartDecision: {
      task_type: "summarize",
      complexity: 1,
      risk: 1,
      selected_canonical_id: flash.id,
      selected: flash,
      ranked_fallback_ids: [haiku.id, opus.id],
      candidates: [flash.id, haiku.id, opus.id]
    },
    isSafeCheap: true,
    maxTier: "cheap"
  });
  assert.equal(withCheapFallback.attempts[1]?.canonical_id, haiku.id);

  const onlyWinnerAndPremium = buildIntelligenceAttempts({
    config,
    registry: [flash, opus],
    primary: "antigravity",
    legacyProvider: "antigravity",
    smartDecision: {
      task_type: "summarize",
      complexity: 1,
      risk: 1,
      selected_canonical_id: flash.id,
      selected: flash,
      ranked_fallback_ids: [opus.id],
      candidates: [flash.id, opus.id]
    },
    isSafeCheap: true,
    maxTier: "cheap"
  });
  // No other cheap provider → premium last resort allowed so final_executed is not null.
  assert.ok(onlyWinnerAndPremium.attempts.length >= 2);
  assert.equal(onlyWinnerAndPremium.attempts[1].canonical_id, opus.id);
  assert.equal(onlyWinnerAndPremium.attempts[1].fallback_reason, "premium_last_resort");
});

test("mergeExecutionConfig defaults providerTimeoutMs to 90s", () => {
  const exec = mergeExecutionConfig({});
  assert.equal(exec.providerTimeoutMs, 90000);
  assert.equal(exec.fallbackOnProviderTimeout, true);
  assert.equal(exec.maxProviderAttempts, 3);
  assert.equal(exec.retrySameProviderOnTimeout, false);
});
