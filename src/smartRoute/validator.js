const TEXT_TASKS = new Set(["chat", "rewrite", "summarize", "math"]);
const SAFE_CHEAP_TASKS = new Set(["chat", "rewrite", "summarize", "extract", "extract_json", "math"]);

const PROVIDER_ERROR_PATTERNS = [
  /\b(rate[_ ]?limit|too many requests|overloaded|capacity)\b/i,
  /\b(internal server error|service unavailable|bad gateway)\b/i,
  /\b(api[_ ]?error|provider[_ ]?error|model[_ ]?error)\b/i,
  /^\s*error\s*:/i
];

const REFUSAL_PATTERNS = [
  /\b(i (?:can'?t|cannot|am unable to|won'?t) (?:help|assist|comply|do that))\b/i,
  /\b(as an ai(?: language)? model[, ]+i (?:can'?t|cannot|am not able))\b/i,
  /\b(i must refuse|i have to refuse|against my (?:guidelines|policies))\b/i
];

const SEVERE_MALFORMED_PATTERNS = [
  /^[\x00-\x08\x0b\x0c\x0e-\x1f]+/,
  /^(?:null|undefined|NaN|\[object Object\])\s*$/i
];

/**
 * Resolve what the validator expects for this decision/request.
 * Chat/rewrite/summarize/math never require schema unless the request explicitly
 * asks for JSON (response_format / requiresStrictJson). Classifier needs_strict_json
 * alone must not force schema on plain text tasks.
 */
export function resolveValidatorIntent(decision = {}, requestMeta = {}) {
  const taskType = decision?.task_type ?? "chat";
  const explicitStrictJson =
    requestMeta.requiresStrictJson === true ||
    requestMeta.responseFormatJson === true ||
    requestMeta.strict_json === true;

  if (explicitStrictJson) {
    return {
      expected_format: "json",
      schema_required: true,
      trigger_source: requestMeta.responseFormatJson ? "response_format" : "strict_json"
    };
  }

  if (taskType === "extract_json") {
    return {
      expected_format: "json",
      schema_required: true,
      trigger_source: "task_type"
    };
  }

  if (taskType === "code" || taskType === "code_debug") {
    return {
      expected_format: "code",
      schema_required: false,
      trigger_source: "task_type"
    };
  }

  if (TEXT_TASKS.has(taskType) || taskType === "extract") {
    return {
      expected_format: "text",
      schema_required: false,
      trigger_source: "none"
    };
  }

  // Unknown / other task types: only honor explicit request-level strict JSON
  // (already handled). Classifier needs_strict_json alone is ignored.
  return {
    expected_format: "text",
    schema_required: false,
    trigger_source: "none"
  };
}

export function validateResponse(content, decision = {}, requestMeta = {}) {
  const intent = resolveValidatorIntent(decision, requestMeta);
  const issues = [];
  const failureCategories = [];
  const text = content == null ? "" : String(content);
  const trimmed = text.trim();
  const taskType = decision?.task_type ?? "chat";

  if (!trimmed) {
    issues.push("empty_response");
    failureCategories.push("empty_output");
  } else {
    if (looksLikeProviderError(trimmed)) {
      issues.push("provider_error_output");
      failureCategories.push("provider_error");
    }

    if (looksLikeRefusal(trimmed) && isSafeRequest(decision, requestMeta)) {
      issues.push("refusal");
      failureCategories.push("refusal");
    }

    if (looksSeverelyMalformed(trimmed)) {
      issues.push("severe_malformed");
      failureCategories.push("severe_malformed");
    }
  }

  if (intent.schema_required && trimmed && !isValidJson(trimmed)) {
    issues.push("invalid_json");
    failureCategories.push("schema_failure");
  }

  // Task-type content checks (non-schema).
  if (trimmed && (taskType === "rewrite" || taskType === "summarize" || taskType === "extract")) {
    // Non-empty text is enough; no JSON requirement.
  }

  if (trimmed && taskType === "summarize" && requestMeta.sourceText) {
    const source = String(requestMeta.sourceText);
    if (source.length >= 80 && trimmed.length > source.length) {
      issues.push("summary_longer_than_source");
      failureCategories.push("weak_answer");
    }
  }

  const codeTask = taskType === "code" || taskType === "code_debug";
  const requireCodeShape =
    codeTask && ((decision?.complexity ?? 0) >= 3 || (decision?.risk ?? 0) >= 3);

  if (requireCodeShape && trimmed && !looksLikeCode(trimmed)) {
    issues.push("missing_code");
    failureCategories.push("weak_answer");
  }

  const category = failureCategories[0] ?? (issues.length ? "validation_failure" : null);
  const result = issues.length ? "fail" : "pass";

  return {
    result,
    issues,
    category,
    failure_categories: [...new Set(failureCategories)],
    validator_expected_format: intent.expected_format,
    validator_schema_required: intent.schema_required,
    validator_trigger_source: intent.trigger_source,
    validator_failure_category: category,
    validator_issues: issues
  };
}

export function shouldEscalate(validation, decision, settings, requestMeta = {}) {
  if (!settings?.escalationEnabled) {
    return false;
  }

  const safePolicy = mergeSafeCheapEscalation(settings);
  if (isSafeCheapEscalationContext(decision, safePolicy)) {
    if (validation?.result === "fail") {
      // Plain chat/text schema_failure is a validator bug — never escalate.
      if (
        validation.category === "schema_failure" &&
        !safePolicy.allowPremiumOnSchemaFailure &&
        !requestMeta.requiresStrictJson &&
        !requestMeta.responseFormatJson &&
        !requestMeta.strict_json
      ) {
        return false;
      }
      return true;
    }
    if ((decision?.confidence ?? 1) < (settings?.confidenceThreshold ?? 0.55)) {
      return true;
    }
    return false;
  }

  if (validation?.result === "fail") {
    return true;
  }
  if ((decision?.confidence ?? 1) < (settings?.confidenceThreshold ?? 0.55)) {
    return true;
  }
  return false;
}

export function isSafeCheapEscalationContext(decision, policy = DEFAULT_SAFE_CHEAP_ESCALATION) {
  const taskType = decision?.task_type ?? "unknown";
  const complexity = decision?.complexity ?? 99;
  const risk = decision?.risk ?? 99;
  const tasks = policy.taskTypes ?? [...SAFE_CHEAP_TASKS];
  return (
    tasks.includes(taskType) &&
    complexity <= (policy.maxComplexity ?? 2) &&
    risk <= (policy.maxRisk ?? 2)
  );
}

export const DEFAULT_SAFE_CHEAP_ESCALATION = {
  taskTypes: ["chat", "rewrite", "summarize", "extract", "extract_json", "math"],
  maxComplexity: 2,
  maxRisk: 2,
  maxEscalationTier: "cheap",
  allowPremiumOnSchemaFailure: false,
  retrySameModelOnce: true,
  fallbackToNextFloorPassingModel: true,
  premiumOnlyAfterRepeatedFailure: true
};

export function mergeSafeCheapEscalation(settings = {}) {
  const configured = settings?.escalation?.safeCheapTasks ?? settings?.safeCheapTasks ?? {};
  return {
    ...DEFAULT_SAFE_CHEAP_ESCALATION,
    ...configured
  };
}

function isSafeRequest(decision, requestMeta) {
  const risk = decision?.risk ?? requestMeta.risk ?? 1;
  return risk <= 2 && !requestMeta.containsSensitiveData;
}

function looksLikeProviderError(text) {
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeRefusal(text) {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

function looksSeverelyMalformed(text) {
  if (SEVERE_MALFORMED_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  // Mostly non-printable / replacement garbage
  const printable = text.replace(/[\s\p{L}\p{N}\p{P}\p{S}]/gu, "");
  return text.length >= 8 && printable.length / text.length > 0.5;
}

function isValidJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

function looksLikeCode(text) {
  const sample = String(text ?? "");
  return (
    /```/.test(sample) ||
    /\b(function|class|const |let |def |import |export )/.test(sample) ||
    /[{};]\s*$/m.test(sample)
  );
}
