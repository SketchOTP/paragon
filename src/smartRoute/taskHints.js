const REWRITE_HINT =
  /\b(rewrite|reword|rephrase|paraphrase|make formal|make professional|polish|professionally)\b/i;
const SUMMARIZE_HINT = /\b(summari[sz]e|summary|tl;dr|tldr|brief summary|shorten)\b/i;
const EXTRACT_JSON_HINT =
  /\b(extract[_ ]?json|return json|as json|json object|json schema|strict json)\b/i;
const EXTRACT_HINT =
  /\b(extract|parse|fields|action items|list .+ from|extract tags|extract bullets|extract dates)\b/i;
const MATH_HINT =
  /\b(arithmetic|calculate|calculation|compute|solve|equation|percent|percentage|convert|formula|\d+\s*[+\-*/×÷^]\s*\d+|what is \d+)\b/i;

const CODE_DEBUG_HINT =
  /\b(debug|fix this bug|stack[\s_-]?trace|failing test|exception|traceback|TypeError|ReferenceError|SyntaxError|why does this code|crashes on|find the bug|error)\b/i;

const ARCHITECTURE_HINT =
  /\b(architecture|system design|design a system|build plan|technical plan|implementation plan|project structure|database schema|service design|end-to-end design|handoff directive|microservices|scalable|orchestrator|router design)\b/i;

const HARD_TASK_MIN_COMPLEXITY = {
  architecture: 4,
  code_debug: 3
};

const HARD_TASK_MIN_TIER = {
  architecture: "premium",
  code_debug: "mid"
};

/** Hard tasks must not be downgraded to chat by the LLM classifier. */
export function inferHardTaskTypeFromPrompt(text) {
  const prompt = String(text ?? "").trim();
  if (!prompt) return null;
  if (ARCHITECTURE_HINT.test(prompt)) return "architecture";
  if (CODE_DEBUG_HINT.test(prompt)) return "code_debug";
  return null;
}

export function inferTaskTypeFromPrompt(text) {
  const prompt = String(text ?? "").trim();
  if (!prompt) {
    return null;
  }
  const hard = inferHardTaskTypeFromPrompt(prompt);
  if (hard) {
    return hard;
  }
  if (MATH_HINT.test(prompt)) {
    return "math";
  }
  if (EXTRACT_JSON_HINT.test(prompt)) {
    return "extract_json";
  }
  if (EXTRACT_HINT.test(prompt)) {
    return "extract";
  }
  if (SUMMARIZE_HINT.test(prompt)) {
    return "summarize";
  }
  if (REWRITE_HINT.test(prompt)) {
    return "rewrite";
  }
  return null;
}

export function applyTaskTypeHint(decision, prompt) {
  const hardHint = inferHardTaskTypeFromPrompt(prompt);
  const softHint = hardHint ? null : inferTaskTypeFromPrompt(prompt);
  const hint = hardHint ?? softHint;
  if (!hint || !decision) {
    return decision;
  }

  // Hard-task override: never allow chat/unknown to stick when a hard hint fires.
  if (hardHint) {
    const minComplexity = HARD_TASK_MIN_COMPLEXITY[hardHint] ?? 3;
    return {
      ...decision,
      task_type: hardHint,
      complexity: Math.max(decision.complexity ?? 1, minComplexity),
      recommended_tier: HARD_TASK_MIN_TIER[hardHint] ?? decision.recommended_tier,
      reason: decision.reason
        ? `${decision.reason} (hard_task_hint=${hardHint})`
        : `Deterministic hard-task hint: ${hardHint}`
    };
  }

  // Soft hints do not override an existing hard task_type.
  if (decision.task_type === "architecture" || decision.task_type === "code_debug") {
    return decision;
  }

  return {
    ...decision,
    task_type: hint,
    reason: decision.reason
      ? `${decision.reason} (task_hint=${hint})`
      : `Deterministic task hint: ${hint}`
  };
}
