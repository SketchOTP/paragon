/**
 * Multidimensional deterministic task profiling (PARAGON-D-004D, Phase 5).
 *
 * Replaces `classifyTask()`'s single first-regex-match label. That classifier
 * tested patterns in fixed object order and took the first hit, so
 * "debug a simple typo" and "investigate a cross-system production
 * regression" produced the identical `debug` profile and therefore the
 * identical premium-leaning routing policy.
 *
 * Every dimension here is derived deterministically from the request — no
 * LLM call, no network, no randomness — so a profile is reproducible and
 * inspectable, and the dashboard can render the exact profile a real
 * request produced.
 */

export const WORK_TYPES = [
  "quick",
  "explain",
  "documentation",
  "code",
  "debug",
  "review",
  "planning",
  "architecture",
  "data_analysis",
  "unknown"
];
export const COMPLEXITIES = ["trivial", "normal", "complex", "extreme"];
export const RISKS = ["low", "normal", "production", "security_critical"];
export const REASONING_DEMANDS = ["minimal", "low", "medium", "high", "maximum"];
export const CONTEXT_BANDS = ["small", "medium", "large", "huge"];
export const OUTPUT_CONTRACTS = ["prose", "code", "json", "json_schema", "tool_call"];
export const LATENCY_PREFERENCES = ["interactive", "normal", "batch"];
export const QUALITY_PREFERENCES = ["economy", "balanced", "maximum"];
export const COST_SENSITIVITIES = ["low", "normal", "high"];

/**
 * Work-type signals. Unlike the old classifier these are *scored*, not
 * first-match: every pattern that hits contributes, and the highest total
 * wins with a documented deterministic tie-break. A request mentioning both
 * "review" and "explain" therefore resolves by weight of evidence rather
 * than by which regex happened to be declared first.
 */
const WORK_TYPE_SIGNALS = [
  { type: "architecture", weight: 3, pattern: /\b(architect\w*|system design|topology|microservice|scalab\w+|distributed system|migration plan)\b/i },
  { type: "planning", weight: 2, pattern: /\b(plan|roadmap|approach|strategy|break down|milestone|estimate the work)\b/i },
  { type: "review", weight: 3, pattern: /\b(review|pull request|\bpr\b|diff|code smell|audit|regression risk)\b/i },
  { type: "debug", weight: 3, pattern: /\b(bug|debug|error|exception|stack trace|traceback|failing|crash|regression|panic|segfault|diagnose)\b/i },
  { type: "data_analysis", weight: 2, pattern: /\b(analy[sz]e|dataset|query|aggregate|statistics|histogram|correlat\w+|sql\b)\b/i },
  { type: "documentation", weight: 2, pattern: /\b(readme|docs?|documentation|changelog|release notes|write[- ]up|docstring)\b/i },
  { type: "explain", weight: 2, pattern: /\b(explain|why does|why is|how does|what does|summari[sz]e|teach me|walk me through)\b/i },
  { type: "code", weight: 2, pattern: /\b(implement|refactor|write a (function|class|test)|add a (feature|method)|typescript|javascript|python|component|endpoint)\b/i },
  { type: "quick", weight: 1, pattern: /\b(quick|one[- ]liner|tiny|trivial|just tell me|shortcut)\b/i }
];

const COMPLEXITY_SIGNALS = {
  extreme: /\b(cross[- ]system|multi[- ]service|end[- ]to[- ]end|entire codebase|whole system|company[- ]wide|large[- ]scale migration)\b/i,
  complex: /\b(complex|intricate|non[- ]trivial|race condition|deadlock|memory leak|intermittent|flaky|heisenbug|root cause|architecture)\b/i,
  trivial: /\b(typo|rename|one[- ]liner|trivial|simple|tiny|small fix|whitespace|lint)\b/i
};

const RISK_SIGNALS = {
  security_critical: /\b(security|vulnerabilit\w+|\bcve\b|exploit|injection|xss|csrf|auth bypass|privilege escalation|secret leak|credential)\b/i,
  production: /\b(production|prod\b|live site|customer[- ]facing|outage|incident|sev[- ]?[12]|hotfix|data loss)\b/i
};

const REASONING_DEMAND_SIGNALS = {
  maximum: /\b(prove|formal|exhaustive|every edge case|rigorous|derive|from first principles)\b/i,
  high: /\b(root cause|why exactly|trade[- ]?offs?|reason through|step by step|carefully|deeply)\b/i,
  minimal: /\b(just|simply|no explanation|one word|yes or no|list only)\b/i
};

const LATENCY_SIGNALS = {
  interactive: /\b(quick|fast|asap|right now|immediately|interactive)\b/i,
  batch: /\b(batch|overnight|background|take your time|thorough(ly)?|no rush)\b/i
};

/** Deterministic tie-break for equal work-type scores: earlier = more specific. */
const WORK_TYPE_PRECEDENCE = [
  "architecture",
  "review",
  "debug",
  "data_analysis",
  "planning",
  "documentation",
  "explain",
  "code",
  "quick",
  "unknown"
];

function pickWorkType(text) {
  const scores = new Map();
  for (const signal of WORK_TYPE_SIGNALS) {
    if (signal.pattern.test(text)) {
      scores.set(signal.type, (scores.get(signal.type) ?? 0) + signal.weight);
    }
  }
  if (!scores.size) {
    return { workType: "unknown", workTypeScores: {} };
  }
  const best = [...scores.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return WORK_TYPE_PRECEDENCE.indexOf(a[0]) - WORK_TYPE_PRECEDENCE.indexOf(b[0]);
  })[0][0];
  return { workType: best, workTypeScores: Object.fromEntries(scores) };
}

export function contextBandFor(estimatedInputTokens, { largeThreshold = 50000, hugeThreshold = 200000 } = {}) {
  const tokens = Number(estimatedInputTokens ?? 0);
  if (!Number.isFinite(tokens) || tokens <= 4000) return "small";
  if (tokens < largeThreshold) return "medium";
  if (tokens < hugeThreshold) return "large";
  return "huge";
}

function outputContractFor(body) {
  const type = body?.response_format?.type;
  if (type === "json_schema") return "json_schema";
  if (type === "json_object") return "json";
  if (Array.isArray(body?.tools) && body.tools.length) return "tool_call";
  return null;
}

/**
 * @param {object} params
 * @param {string} params.prompt - flattened request text (never stored)
 * @param {object} [params.body] - the OpenAI-compatible request body
 * @param {number|null} [params.estimatedInputTokens]
 * @param {object} [params.hints] - routing hints (maxCostClass etc.)
 * @param {object} [params.options] - thresholds
 */
export function buildTaskProfile({ prompt = "", body = {}, estimatedInputTokens = null, hints = {}, options = {} } = {}) {
  const text = String(prompt ?? "");

  const { workType, workTypeScores } = pickWorkType(text);

  let complexity = "normal";
  if (COMPLEXITY_SIGNALS.extreme.test(text)) complexity = "extreme";
  else if (COMPLEXITY_SIGNALS.complex.test(text)) complexity = "complex";
  else if (COMPLEXITY_SIGNALS.trivial.test(text)) complexity = "trivial";

  let risk = "normal";
  if (RISK_SIGNALS.security_critical.test(text)) risk = "security_critical";
  else if (RISK_SIGNALS.production.test(text)) risk = "production";
  else if (complexity === "trivial") risk = "low";

  const contextBand = contextBandFor(estimatedInputTokens, options);

  // Reasoning demand: explicit language wins; otherwise derived from the
  // work type crossed with complexity and risk, so "debug a typo" and
  // "debug a production race condition" no longer collapse together.
  let reasoningDemand;
  if (REASONING_DEMAND_SIGNALS.maximum.test(text)) reasoningDemand = "maximum";
  else if (REASONING_DEMAND_SIGNALS.minimal.test(text)) reasoningDemand = "minimal";
  else if (REASONING_DEMAND_SIGNALS.high.test(text)) reasoningDemand = "high";
  else reasoningDemand = derivedReasoningDemand(workType, complexity, risk);

  const outputContract = outputContractFor(body) ?? (workType === "code" || workType === "debug" ? "code" : "prose");

  const requiredCapabilities = ["chatCompletions"];
  if (body?.stream) requiredCapabilities.push("streaming");
  if (Array.isArray(body?.tools) && body.tools.length) requiredCapabilities.push("toolCalls");
  if (outputContract === "json") requiredCapabilities.push("structuredOutput");
  if (outputContract === "json_schema") requiredCapabilities.push("structuredOutput", "jsonSchema");
  if (hasImageContent(body)) requiredCapabilities.push("visionInput");
  if (hasAudioContent(body)) requiredCapabilities.push("audioInput");

  let latencyPreference = "normal";
  if (LATENCY_SIGNALS.batch.test(text)) latencyPreference = "batch";
  else if (LATENCY_SIGNALS.interactive.test(text) || body?.stream) latencyPreference = "interactive";

  const qualityPreference =
    risk === "security_critical" || complexity === "extreme"
      ? "maximum"
      : complexity === "trivial" || workType === "quick"
        ? "economy"
        : "balanced";

  // An explicit caller cost ceiling is a stronger statement than any
  // inference from the prompt text.
  const costSensitivity = hints?.maxCostClass === "economy" ? "high" : qualityPreference === "maximum" ? "low" : "normal";

  return {
    workType,
    workTypeScores,
    complexity,
    risk,
    reasoningDemand,
    contextBand,
    outputContract,
    requiredCapabilities,
    latencyPreference,
    qualityPreference,
    costSensitivity,
    estimatedInputTokens: estimatedInputTokens ?? null,
    requestedMaxOutputTokens: Number.isFinite(body?.max_tokens) ? body.max_tokens : null,
    profileSource: "deterministic_v1"
  };
}

function derivedReasoningDemand(workType, complexity, risk) {
  if (complexity === "trivial") return "minimal";
  if (risk === "security_critical") return "maximum";
  if (complexity === "extreme") return "maximum";
  if (workType === "architecture") return complexity === "complex" ? "maximum" : "high";
  if (workType === "review" || workType === "planning") return risk === "production" ? "high" : "medium";
  if (workType === "debug") return complexity === "complex" || risk === "production" ? "high" : "medium";
  if (workType === "quick" || workType === "explain") return "low";
  if (workType === "documentation") return "low";
  if (workType === "data_analysis") return "medium";
  return "medium";
}

function messageContentParts(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const parts = [];
  for (const message of messages) {
    if (Array.isArray(message?.content)) {
      parts.push(...message.content);
    }
  }
  return parts;
}

function hasImageContent(body) {
  return messageContentParts(body).some((part) => part?.type === "image_url" || part?.type === "image" || part?.type === "input_image");
}

function hasAudioContent(body) {
  return messageContentParts(body).some((part) => part?.type === "input_audio" || part?.type === "audio");
}
