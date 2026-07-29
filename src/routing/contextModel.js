/**
 * Practical context model (PARAGON-D-004D, Phase 4).
 *
 * Replaces family-wide guesses as the *primary* source. The prior behavior
 * gave every `claude-*` 200000 tokens, every `gpt-5*` 400000, and `null` to
 * everything else — then penalized unknown context by only −3 points for
 * requests over 50k tokens rather than excluding it. That let a large
 * request route to a model whose real limit was unknown, and ignored that a
 * provider CLI wrapper can impose a *lower* practical ceiling than the
 * underlying API model.
 *
 * The governing number is the minimum of every known limit, minus room for
 * the response, minus a safety margin.
 */

export const CONTEXT_EVIDENCE_SOURCES = [
  "authenticated_model_metadata",
  "provider_capability_output",
  "observed_acceptance",
  "operator_configuration",
  "public_documentation",
  "unknown"
];

const SOURCE_CONFIDENCE = {
  authenticated_model_metadata: "high",
  provider_capability_output: "high",
  observed_acceptance: "medium",
  operator_configuration: "medium",
  public_documentation: "low",
  unknown: "none"
};

/**
 * Publicly documented context windows, by canonical model prefix. Demoted to
 * the *lowest* evidence tier (`public_documentation`) — it is a real source,
 * but any metadata, capability output, observation, or operator setting
 * outranks it.
 */
const DOCUMENTED_CONTEXT_WINDOWS = [
  { pattern: /^claude-/, tokens: 200000 },
  { pattern: /^gpt-5/, tokens: 400000 },
  { pattern: /^gpt-oss/, tokens: 131072 },
  { pattern: /^gemini-3/, tokens: 1000000 }
];

/**
 * Provider CLI wrapper ceilings. A wrapper can accept far less than the
 * model's API limit (prompt assembled as argv/stdin, its own truncation,
 * etc.). Left `null` where PARAGON has no evidence — `null` means "no known
 * wrapper ceiling", NOT "unlimited", and never raises a lower limit.
 */
const PROVIDER_WRAPPER_CONTEXT = {
  claude: null,
  codex: null,
  cursor: null,
  antigravity: null
};

function documentedContextFor(canonicalModelId) {
  const id = String(canonicalModelId ?? "").toLowerCase();
  const found = DOCUMENTED_CONTEXT_WINDOWS.find((entry) => entry.pattern.test(id));
  return found ? found.tokens : null;
}

/**
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.canonicalModelId
 * @param {object} [params.catalogEntry] - may carry provider-declared context metadata
 * @param {object} [params.telemetry] - observed accepted/rejected context evidence
 * @param {object} [params.operatorConfig] - reviewed per-model overrides
 * @param {number} [params.outputTokenReserve]
 * @param {number} [params.safetyMarginRatio]
 */
export function buildContextModel({
  provider,
  canonicalModelId,
  catalogEntry = null,
  telemetry = null,
  operatorConfig = null,
  outputTokenReserve = 4096,
  safetyMarginRatio = 0.05
} = {}) {
  const metadataContext = numberOrNull(
    catalogEntry?.metadata?.context_length ?? catalogEntry?.metadata?.context_window ?? catalogEntry?.metadata?.max_context_tokens
  );
  const operatorContext = numberOrNull(operatorConfig?.contextWindow);
  const observedContext = numberOrNull(telemetry?.observedAcceptedContextWindow);
  const documentedContext = documentedContextFor(canonicalModelId);
  const wrapperContext = numberOrNull(operatorConfig?.wrapperContextWindow ?? PROVIDER_WRAPPER_CONTEXT[provider]);

  // Highest-authority source that actually has a value determines the
  // reported evidence tier.
  let modelAdvertisedContextWindow = null;
  let contextEvidenceSource = "unknown";
  if (metadataContext != null) {
    modelAdvertisedContextWindow = metadataContext;
    contextEvidenceSource = "authenticated_model_metadata";
  } else if (operatorContext != null) {
    modelAdvertisedContextWindow = operatorContext;
    contextEvidenceSource = "operator_configuration";
  } else if (observedContext != null) {
    modelAdvertisedContextWindow = observedContext;
    contextEvidenceSource = "observed_acceptance";
  } else if (documentedContext != null) {
    modelAdvertisedContextWindow = documentedContext;
    contextEvidenceSource = "public_documentation";
  }

  // The effective ceiling is the minimum of everything known. A wrapper or
  // observation can only ever lower it.
  const knownLimits = [modelAdvertisedContextWindow, wrapperContext, observedContext].filter((v) => v != null);
  const hardLimit = knownLimits.length ? Math.min(...knownLimits) : null;

  const reserve = Math.max(0, Number(operatorConfig?.outputTokenReserve ?? outputTokenReserve) || 0);
  const margin = hardLimit != null ? Math.ceil(hardLimit * safetyMarginRatio) : 0;
  const effectiveUsableContextWindow = hardLimit != null ? Math.max(0, hardLimit - reserve - margin) : null;

  return {
    modelAdvertisedContextWindow,
    providerWrapperContextWindow: wrapperContext,
    observedAcceptedContextWindow: observedContext,
    outputTokenReserve: reserve,
    contextSafetyMargin: margin,
    effectiveUsableContextWindow,
    maximumOutputTokens: numberOrNull(catalogEntry?.metadata?.max_output_tokens ?? operatorConfig?.maxOutputTokens),
    contextEvidenceSource,
    contextConfidence: SOURCE_CONFIDENCE[contextEvidenceSource] ?? "none"
  };
}

/**
 * Hard context gate.
 *
 * Two rules the old scorer lacked:
 *  - Required output capacity counts against the window, not just input.
 *  - Above `unknownLargeContextThresholdTokens`, an unknown context limit is
 *    *ineligible* rather than merely penalized. Below that threshold unknown
 *    stays eligible so a small request is not blocked by missing metadata.
 */
export function checkContextFit({
  contextModel,
  estimatedInputTokens,
  requiredOutputTokens = 0,
  unknownLargeContextThresholdTokens = 50000
}) {
  const input = Number(estimatedInputTokens ?? 0);
  const required = input + Math.max(0, Number(requiredOutputTokens ?? 0));

  if (contextModel?.effectiveUsableContextWindow == null) {
    if (input >= unknownLargeContextThresholdTokens) {
      return {
        ok: false,
        reasonCode: "routing.unknownContextForLargeRequest",
        detail: `context capacity unknown and estimated input ${input} >= threshold ${unknownLargeContextThresholdTokens}`
      };
    }
    return { ok: true, unknownContext: true };
  }

  if (required > contextModel.effectiveUsableContextWindow) {
    return {
      ok: false,
      reasonCode: "routing.contextWindowExceeded",
      detail: `needs ${required} (input ${input} + output reserve ${Math.max(0, Number(requiredOutputTokens ?? 0))}) > usable ${contextModel.effectiveUsableContextWindow}`
    };
  }
  return { ok: true, unknownContext: false };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
