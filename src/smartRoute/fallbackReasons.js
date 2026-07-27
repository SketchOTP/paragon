import { formatProviderError } from "../providerFallback.js";

export const FALLBACK_REASONS = [
  "provider_timeout",
  "provider_error",
  "provider_unavailable",
  "rate_limited",
  "context_overflow",
  "validation_failure",
  "classifier_low_confidence",
  "budget_block",
  "capability_missing",
  "unknown"
];

export function classifyProviderError(error) {
  const text = `${error?.message ?? ""} ${error?.stderr ?? ""} ${error?.stdout ?? ""}`.toLowerCase();

  if (error?.timeout || text.includes("timed out") || text.includes("timeout")) {
    return "provider_timeout";
  }
  if (
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("429") ||
    text.includes("too many requests")
  ) {
    return "rate_limited";
  }
  if (
    text.includes("context length") ||
    text.includes("context window") ||
    text.includes("maximum context") ||
    text.includes("token limit") ||
    text.includes("context_overflow")
  ) {
    return "context_overflow";
  }
  if (
    text.includes("enoent") ||
    text.includes("not found") ||
    text.includes("command not found") ||
    text.includes("econnrefused") ||
    text.includes("unavailable")
  ) {
    return "provider_unavailable";
  }
  if (text.includes("empty stdout") || text.includes("empty_response") || text.includes("blank text")) {
    return "provider_error";
  }
  if (text.includes("provider failed") || error?.code != null || error?.message) {
    return "provider_error";
  }
  return "unknown";
}

export function buildProviderSwitch({
  originalSmartProvider,
  attemptedProvider,
  attemptedModel,
  fallbackToProvider,
  fallbackReason,
  rawError
}) {
  const entry = {
    original_smart_provider: originalSmartProvider ?? null,
    attempted_provider: attemptedProvider ?? null,
    attempted_model: attemptedModel ?? null,
    fallback_to_provider: fallbackToProvider ?? null,
    fallback_reason: fallbackReason ?? "unknown"
  };
  if (entry.fallback_reason === "unknown") {
    entry.raw_error_summary = (rawError ?? "unspecified").slice(0, 300);
  }
  return entry;
}

export function escalationReasonFromValidation(validation, classifier, settings) {
  if (validation?.result === "fail") {
    if (validation.category === "schema_failure") {
      return "validation_failure";
    }
    if (validation.category === "weak_answer" || validation.category === "empty_output") {
      return "validation_failure";
    }
    return "validation_failure";
  }
  if ((classifier?.confidence ?? 1) < (settings?.confidenceThreshold ?? 0.55)) {
    return "classifier_low_confidence";
  }
  return "validation_failure";
}

export function summarizeRawError(error) {
  return formatProviderError(error).slice(0, 300);
}
