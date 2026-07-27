import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateResponse,
  shouldEscalate,
  resolveValidatorIntent,
  mergeSafeCheapEscalation
} from "../src/smartRoute/validator.js";
import { findSafeCheapEscalationCandidate } from "../src/smartRoute/escalation.js";
import { inferTaskTypeFromPrompt, applyTaskTypeHint } from "../src/smartRoute/taskHints.js";
import { PROMPTS } from "../scripts/cheap-task-trial-prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cheapFlash = {
  id: "antigravity:Gemini 3.5 Flash (High)",
  provider: "antigravity",
  model: "Gemini 3.5 Flash (High)",
  tier: "cheap",
  pricing: { input_per_1m: 0.1, output_per_1m: 0.4 },
  routing: { priority: 40, fallbacks: [] }
};

const cheapHaiku = {
  id: "claude:claude-haiku-4-5",
  provider: "claude",
  model: "claude-haiku-4-5",
  tier: "cheap",
  pricing: { input_per_1m: 0.8, output_per_1m: 4 },
  routing: { priority: 50, fallbacks: [] }
};

const premiumOpus = {
  id: "claude:claude-opus-4-6",
  provider: "claude",
  model: "claude-opus-4-6",
  tier: "premium",
  pricing: { input_per_1m: 15, output_per_1m: 75 },
  routing: { priority: 90, fallbacks: [] }
};

const registry = [cheapFlash, cheapHaiku, premiumOpus];

const safeSettings = {
  escalationEnabled: true,
  confidenceThreshold: 0.55,
  escalation: {
    safeCheapTasks: {
      maxEscalationTier: "cheap",
      allowPremiumOnSchemaFailure: false,
      retrySameModelOnce: true,
      fallbackToNextFloorPassingModel: true,
      premiumOnlyAfterRepeatedFailure: true
    }
  }
};

test("chat text response does not trigger schema_failure", () => {
  const result = validateResponse("Hello! How can I help?", {
    task_type: "chat",
    complexity: 1,
    risk: 1,
    needs_strict_json: true
  });
  assert.equal(result.result, "pass");
  assert.equal(result.category, null);
  assert.equal(result.validator_schema_required, false);
  assert.equal(result.validator_expected_format, "text");
});

test("chat only requires schema when strict_json=true", () => {
  const prose = validateResponse("Hello there.", {
    task_type: "chat",
    needs_strict_json: true
  });
  assert.equal(prose.result, "pass");

  const strictFail = validateResponse("Hello there.", {
    task_type: "chat"
  }, { requiresStrictJson: true });
  assert.equal(strictFail.result, "fail");
  assert.equal(strictFail.category, "schema_failure");
  assert.equal(strictFail.validator_schema_required, true);
  assert.equal(strictFail.validator_trigger_source, "strict_json");

  const strictPass = validateResponse('{"ok":true}', {
    task_type: "chat"
  }, { requiresStrictJson: true });
  assert.equal(strictPass.result, "pass");
});

test("rewrite text response does not trigger schema_failure", () => {
  const result = validateResponse("Please send the file as soon as possible.", {
    task_type: "rewrite",
    complexity: 1,
    risk: 1,
    needs_strict_json: true
  });
  assert.equal(result.result, "pass");
  assert.equal(result.validator_schema_required, false);
});

test("summarize text response does not trigger schema_failure", () => {
  const result = validateResponse("SmartRoute records each routing decision.", {
    task_type: "summarize",
    complexity: 1,
    risk: 1,
    needs_strict_json: true
  });
  assert.equal(result.result, "pass");
  assert.equal(result.validator_schema_required, false);
});

test("extract_json requires valid JSON", () => {
  const fail = validateResponse("Name is Alex", { task_type: "extract_json" });
  assert.equal(fail.result, "fail");
  assert.equal(fail.category, "schema_failure");
  assert.equal(fail.validator_trigger_source, "task_type");

  const pass = validateResponse('{"name":"Alex"}', { task_type: "extract_json" });
  assert.equal(pass.result, "pass");
});

test("extract without JSON does not require JSON", () => {
  const result = validateResponse("- Name: Alex\n- Role: PM", {
    task_type: "extract",
    needs_strict_json: true
  });
  assert.equal(result.result, "pass");
  assert.equal(result.validator_schema_required, false);
});

test("safe cheap chat schema_failure does not escalate to premium opus", () => {
  const decision = { task_type: "chat", complexity: 1, risk: 1, confidence: 0.98 };
  const validation = validateResponse("Plain chat answer.", {
    ...decision,
    needs_strict_json: true
  });
  assert.equal(validation.result, "pass");

  // Even if an old validator marked schema_failure, policy must not escalate to opus.
  const bogusValidation = {
    result: "fail",
    category: "schema_failure",
    issues: ["invalid_json"]
  };
  assert.equal(shouldEscalate(bogusValidation, decision, safeSettings), false);

  const next = findSafeCheapEscalationCandidate({
    registry,
    currentEntry: cheapFlash,
    validation: bogusValidation,
    decision,
    settings: safeSettings,
    floorPassingCandidates: [cheapFlash, cheapHaiku, premiumOpus],
    sameModelRetried: false
  });
  assert.equal(next.skip, true);
  assert.equal(next.entry, null);
  assert.notEqual(next.entry?.id, premiumOpus.id);
});

test("safe cheap task escalation chooses next cheapest floor-passing model", () => {
  const decision = { task_type: "chat", complexity: 1, risk: 1, confidence: 0.9 };
  const validation = {
    result: "fail",
    category: "empty_output",
    issues: ["empty_response"]
  };

  const retry = findSafeCheapEscalationCandidate({
    registry,
    currentEntry: cheapFlash,
    validation,
    decision,
    settings: safeSettings,
    floorPassingCandidates: [cheapFlash, cheapHaiku, premiumOpus],
    sameModelRetried: false
  });
  assert.equal(retry.retrySame, true);
  assert.equal(retry.entry.id, cheapFlash.id);

  const next = findSafeCheapEscalationCandidate({
    registry,
    currentEntry: cheapFlash,
    validation,
    decision,
    settings: safeSettings,
    floorPassingCandidates: [cheapFlash, cheapHaiku, premiumOpus],
    sameModelRetried: true
  });
  assert.equal(next.entry.id, cheapHaiku.id);
  assert.equal(next.reason, "next_floor_passing_model");
  assert.notEqual(next.entry.id, premiumOpus.id);
});

test("math prompt classifies as math, not chat", () => {
  assert.equal(inferTaskTypeFromPrompt("What is 12 + 19?"), "math");
  assert.equal(inferTaskTypeFromPrompt("Please calculate 15% of 80"), "math");
  assert.equal(inferTaskTypeFromPrompt("Solve the equation 2x=10"), "math");

  const decision = applyTaskTypeHint(
    { task_type: "chat", complexity: 1, risk: 1 },
    "What is 12 + 19?"
  );
  assert.equal(decision.task_type, "math");
});

test("validator logs expected_format and schema_required", () => {
  const chat = resolveValidatorIntent({ task_type: "chat" });
  assert.equal(chat.expected_format, "text");
  assert.equal(chat.schema_required, false);
  assert.equal(chat.trigger_source, "none");

  const json = resolveValidatorIntent({ task_type: "chat" }, { requiresStrictJson: true });
  assert.equal(json.expected_format, "json");
  assert.equal(json.schema_required, true);

  const logged = validateResponse("hi", { task_type: "chat" });
  assert.equal(logged.validator_expected_format, "text");
  assert.equal(logged.validator_schema_required, false);
  assert.equal(logged.validator_trigger_source, "none");
  assert.deepEqual(logged.validator_issues, []);
});

test("mergeSafeCheapEscalation reads routing.smartRoute.escalation.safeCheapTasks", () => {
  const policy = mergeSafeCheapEscalation(safeSettings);
  assert.equal(policy.maxEscalationTier, "cheap");
  assert.equal(policy.allowPremiumOnSchemaFailure, false);
  assert.equal(policy.retrySameModelOnce, true);
});

test("validator replay: failed trial chat schema_failure rows no longer fail", () => {
  const fixturePath = path.join(__dirname, "fixtures/trial20-failed-validator.jsonl");
  const rows = fs
    .readFileSync(fixturePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(rows.length, 20);

  const promptByTaskType = Object.fromEntries(
    PROMPTS.map((p) => [p.id, p])
  );

  // Map trial rows to representative natural-language responses (log has no body).
  const proseByTaskType = {
    chat: "A normal natural-language answer.",
    math: "31",
    rewrite: "Please send the file as soon as possible.",
    summarize: "SmartRoute logs every routing decision.",
    extract: "- Name: Alex\n- Role: PM"
  };

  let schemaFailures = 0;
  let wouldEscalateToPremium = 0;
  let validationFailures = 0;

  for (const row of rows) {
    const taskType = row.task_type ?? "chat";
    const decision = {
      task_type: taskType,
      complexity: row.complexity ?? 1,
      risk: row.risk ?? 1,
      confidence: row.router_confidence ?? 0.9,
      // Reproduce the buggy classifier flag that caused the trial failures.
      needs_strict_json: row.validator_failure_category === "schema_failure"
    };
    const response = proseByTaskType[taskType] ?? "ok";
    const validation = validateResponse(response, decision, {
      requiresStrictJson: false
    });

    if (validation.result === "fail") {
      validationFailures += 1;
    }
    if (validation.category === "schema_failure") {
      schemaFailures += 1;
    }

    const escalate = shouldEscalate(validation, decision, safeSettings);
    if (escalate) {
      const next = findSafeCheapEscalationCandidate({
        registry,
        currentEntry: cheapFlash,
        validation,
        decision,
        settings: safeSettings,
        floorPassingCandidates: [cheapFlash, cheapHaiku, premiumOpus],
        sameModelRetried: true
      });
      if (next?.entry?.tier === "premium") {
        wouldEscalateToPremium += 1;
      }
    } else if (row.validator_failure_category === "schema_failure") {
      // Prior schema_failure must not escalate under the new policy.
      const next = findSafeCheapEscalationCandidate({
        registry,
        currentEntry: cheapFlash,
        validation: {
          result: "fail",
          category: "schema_failure",
          issues: ["invalid_json"]
        },
        decision,
        settings: safeSettings,
        floorPassingCandidates: [cheapFlash, cheapHaiku, premiumOpus],
        sameModelRetried: true
      });
      assert.equal(next.skip, true);
    }

    // Intent fields always present.
    assert.ok(validation.validator_expected_format);
    assert.equal(typeof validation.validator_schema_required, "boolean");
  }

  // Previous chat schema_failure rows no longer fail unless strict_json.
  const priorSchemaRows = rows.filter((r) => r.validator_failure_category === "schema_failure");
  assert.ok(priorSchemaRows.length >= 1);
  for (const row of priorSchemaRows) {
    const validation = validateResponse("Plain chat answer.", {
      task_type: row.task_type,
      complexity: row.complexity,
      risk: row.risk,
      needs_strict_json: true
    });
    assert.equal(validation.result, "pass", `row ${row.request_id} should pass`);
  }

  assert.equal(schemaFailures, 0);
  assert.equal(wouldEscalateToPremium, 0);
  assert.ok(validationFailures / rows.length < 0.1, `validation failure rate ${validationFailures}/${rows.length}`);

  // Quality escalation target: prior premium escalations must not recur for prose.
  const priorPremiumEscalations = rows.filter(
    (r) => r.quality_escalation_used && r.final_executed_canonical_id === premiumOpus.id
  ).length;
  assert.ok(priorPremiumEscalations >= 1);
  assert.equal(wouldEscalateToPremium, 0);

  // Math prompt from trial set classifies as math.
  const mathPrompt = PROMPTS.find((p) => p.id === "chat-2");
  assert.equal(inferTaskTypeFromPrompt(mathPrompt.message), "math");
  assert.ok(promptByTaskType["chat-2"]);
});
