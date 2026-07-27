const SIMPLE_PATTERNS = [
  /\b(grammar|typo|spelling|punctuation)\b/i,
  /\b(summari[sz]e|tl;dr|brief)\b/i,
  /\b(rewrite|rephrase|paraphrase)\b/i,
  /\b(extract|parse|convert to json)\b/i,
  /\b(format|bullet|list)\b/i,
  /\b(hello|hi|thanks|thank you)\b/i
];

const COMPLEX_PATTERNS = [
  /\b(architecture|system design|microservices)\b/i,
  /\b(debug|stack trace|exception|regression)\b/i,
  /\b(refactor|multi-?file|codebase)\b/i,
  /\b(legal|medical|financial|compliance)\b/i,
  /\b(proof|theorem|derive|calculus)\b/i
];

export function extractFeatures(normalized) {
  const text = normalized.prompt;
  const simpleHits = countMatches(text, SIMPLE_PATTERNS);
  const complexHits = countMatches(text, COMPLEX_PATTERNS);

  const isObviousSimple =
    normalized.estimatedTokens < 120 &&
    simpleHits > 0 &&
    complexHits === 0 &&
    !normalized.requiresTools &&
    !normalized.hasImage &&
    !normalized.requiresStrictJson;

  const complexityHint = inferComplexityHint(text, normalized, simpleHits, complexHits);

  return {
    ...normalized,
    simpleHits,
    complexHits,
    isObviousSimple,
    complexityHint,
    riskHint: inferRiskHint(text)
  };
}

function countMatches(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

function inferComplexityHint(text, normalized, simpleHits, complexHits) {
  if (complexHits >= 2 || normalized.estimatedTokens > 8000) {
    return 5;
  }
  if (complexHits >= 1 || normalized.estimatedTokens > 3000) {
    return 4;
  }
  if (normalized.requiresTools || normalized.requiresStrictJson) {
    return 3;
  }
  if (simpleHits >= 1 && normalized.estimatedTokens < 500) {
    return 2;
  }
  if (normalized.estimatedTokens < 200) {
    return 1;
  }
  return 3;
}

function inferRiskHint(text) {
  if (/\b(legal|medical|financial|diagnos|prescri|lawsuit|contract)\b/i.test(text)) {
    return 5;
  }
  if (/\b(production|security|password|credential)\b/i.test(text)) {
    return 3;
  }
  return 1;
}

export function cheapStaticDecision(features) {
  const complexity = features.complexityHint;
  const risk = features.riskHint;
  let taskType = "chat";
  if (features.hasImage) taskType = "vision";
  else if (features.requiresTools) taskType = "tool_use";
  else if (
    /\b(architecture|system design|design a system|microservices|implementation plan|service design)\b/i.test(
      features.prompt
    )
  ) {
    taskType = "architecture";
  } else if (
    /\b(debug|fix this bug|stack[\s_-]?trace|failing test|exception|traceback|TypeError|find the bug)\b/i.test(
      features.prompt
    )
  ) {
    taskType = "code_debug";
  } else if (
    /\b(arithmetic|calculate|calculation|compute|solve|equation|percent|percentage|convert|formula|\d+\s*[+\-*/×÷^]\s*\d+|what is \d+)\b/i.test(
      features.prompt
    )
  ) {
    taskType = "math";
  } else if (/\b(extract[_ ]?json|return json|as json|json object)\b/i.test(features.prompt)) {
    taskType = "extract_json";
  } else if (/\b(code|implement|function|class|api)\b/i.test(features.prompt)) taskType = "code";
  else if (/\b(extract|parse|fields|action items)\b/i.test(features.prompt)) taskType = "extract";
  else if (/\b(summari[sz]e|summary|tl;dr|tldr)\b/i.test(features.prompt)) taskType = "summarize";
  else if (/\b(rewrite|rephrase|reword|make formal|polish)\b/i.test(features.prompt)) taskType = "rewrite";

  const recommendedTier = tierForComplexity(complexity, risk);

  return {
    task_type: taskType,
    complexity,
    risk,
    needs_tools: features.requiresTools,
    needs_vision: features.hasImage,
    needs_long_context: features.estimatedTokens > 50_000,
    needs_strict_json: features.requiresStrictJson,
    privacy_level: features.containsSensitiveData ? "sensitive" : "normal",
    recommended_tier: recommendedTier,
    confidence: 0.85,
    reason: "Static feature scoring for obvious simple request."
  };
}

function tierForComplexity(complexity, risk) {
  const score = Math.max(complexity, Math.ceil(risk / 2));
  if (score <= 1) return "local";
  if (score <= 2) return "cheap";
  if (score <= 3) return "mid";
  return "premium";
}
