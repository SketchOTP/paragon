/**
 * Validated capability profiles and request capability gates
 * (PARAGON-D-004D, Phase 3).
 *
 * PARAGON-D-004C1 shipped a deliberately minimum gate — `chatCompletions`
 * only — because inventing tool/JSON/multimodal support would have been the
 * same class of error as the blanket `coding/tools/streaming: true` it
 * replaced. This module adds the full profile, still on the same rule:
 * a capability is only `true` on positive evidence, and `unknown` never
 * satisfies a requirement.
 *
 * Evidence hierarchy (highest first):
 *   1. authenticated_capability_response
 *   2. provider_model_metadata
 *   3. bounded_capability_probe
 *   4. operator_mapping   (explicit reviewed)
 *   5. unknown
 */

import { classifyChatCapability, isProviderDefaultId } from "../modelCapability.js";

export const CAPABILITY_FIELDS = [
  "chatCompletions",
  "streaming",
  "toolCalls",
  "structuredOutput",
  "jsonSchema",
  "visionInput",
  "audioInput",
  "codeGeneration",
  "reasoningControls",
  "providerDefault"
];

export const CAPABILITY_SOURCES = [
  "authenticated_capability_response",
  "provider_model_metadata",
  "bounded_capability_probe",
  "operator_mapping",
  "unknown"
];

const SOURCE_CONFIDENCE = {
  authenticated_capability_response: "high",
  provider_model_metadata: "high",
  bounded_capability_probe: "medium",
  operator_mapping: "medium",
  unknown: "none"
};

/**
 * Capabilities that are inherent to *how PARAGON invokes a provider*, rather
 * than properties of the model. These are structural facts about the
 * integration, not inferences about the model, which is why they can be
 * asserted without per-model evidence:
 *
 *  - Every builtin provider is driven as a single-shot text completion with
 *    tools disabled (see src/cli.js providerSpecs, PARAGON-D-004B-R). So
 *    `toolCalls` is *structurally* false for them regardless of whether the
 *    underlying model supports tool calling — PARAGON cannot surface it.
 *  - `streaming` is implemented by PARAGON for every provider
 *    (runProcess/onChunk and SSE for HTTP), so it is true at the gateway
 *    level.
 */
const PROVIDER_STRUCTURAL_CAPABILITIES = {
  claude: { streaming: true, toolCalls: false, reasoningControls: false },
  codex: { streaming: true, toolCalls: false, reasoningControls: false },
  cursor: { streaming: true, toolCalls: false, reasoningControls: true },
  antigravity: { streaming: true, toolCalls: false, reasoningControls: false }
};

/** HTTP providers are OpenAI-compatible; capability depends on the server, not on PARAGON. */
const HTTP_STRUCTURAL_CAPABILITIES = { streaming: true, toolCalls: "unknown", reasoningControls: "unknown" };

/**
 * Any other command-line provider (an operator-added `generic-cli`). PARAGON
 * drives it exactly like a builtin — single-shot text completion, streamed
 * through runProcess/onChunk — so the same structural facts hold.
 *
 * PARAGON-D-004E: without this default, an operator-added CLI provider had
 * `streaming: "unknown"`, and because `unknown` never satisfies a requirement
 * it was excluded from *every* streaming request. Streaming is implemented by
 * the gateway, not the provider, so leaving it unknown was wrong.
 */
const GENERIC_CLI_STRUCTURAL_CAPABILITIES = { streaming: true, toolCalls: false, reasoningControls: "unknown" };

function metadataCapability(metadata, field) {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const caps = metadata.capabilities;
  if (caps && typeof caps === "object" && field in caps) {
    const value = caps[field];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/**
 * Builds a capability profile for one (provider, providerModelId, profile).
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.providerModelId
 * @param {object} [params.catalogEntry] - persisted catalog entry (may carry provider metadata)
 * @param {object} [params.executionProfile] - from parseExecutionProfile()
 * @param {object} [params.operatorMapping] - reviewed overrides for this pair
 * @param {boolean} [params.isHttpProvider]
 */
export function buildCapabilityProfile({
  provider,
  providerModelId,
  catalogEntry = null,
  executionProfile = null,
  operatorMapping = null,
  isHttpProvider = false
} = {}) {
  const profile = {};
  for (const field of CAPABILITY_FIELDS) {
    profile[field] = "unknown";
  }

  let source = "unknown";

  // Chat capability reuses the D-004C1 classifier so the two can never
  // disagree about what is routable at all.
  const chat = classifyChatCapability({ modelId: providerModelId, metadata: catalogEntry?.metadata });
  profile.chatCompletions = chat === "supported" ? true : chat === "unsupported" ? false : "unknown";
  if (chat !== "unknown") {
    source = "provider_model_metadata";
  }

  profile.providerDefault = isProviderDefaultId(providerModelId);

  // Structural integration facts.
  const structural = isHttpProvider
    ? HTTP_STRUCTURAL_CAPABILITIES
    : (PROVIDER_STRUCTURAL_CAPABILITIES[provider] ?? GENERIC_CLI_STRUCTURAL_CAPABILITIES);
  if (structural) {
    for (const [field, value] of Object.entries(structural)) {
      profile[field] = value;
    }
    source = source === "unknown" ? "provider_model_metadata" : source;
  }

  // An explicitly parsed reasoning effort is itself evidence that the
  // provider exposes reasoning controls for this model.
  if (executionProfile && executionProfile.reasoningEffort !== "unknown") {
    profile.reasoningControls = true;
  }

  // Provider-declared metadata beats structural defaults for model-level
  // capabilities (an OpenAI-compatible server may advertise them).
  for (const field of CAPABILITY_FIELDS) {
    const declared = metadataCapability(catalogEntry?.metadata, field);
    if (declared !== undefined) {
      profile[field] = declared;
      source = "provider_model_metadata";
    }
  }

  // Operator-reviewed mapping is authoritative over inference.
  if (operatorMapping && typeof operatorMapping === "object") {
    for (const field of CAPABILITY_FIELDS) {
      if (field in operatorMapping) {
        profile[field] = operatorMapping[field];
      }
    }
    source = "operator_mapping";
  }

  // Catalog state is itself chat-capability evidence, because of how the
  // PARAGON-D-004C catalog is built:
  //
  //  - `validated` means a real bounded *chat completion* probe succeeded
  //    against this exact model (modelCatalogRefresh.js defaultProbe), which
  //    is direct execution evidence — stronger than any metadata.
  //  - `exposed` means the provider's own authoritative model-list command
  //    returned it as an available chat model.
  //
  // Without this, every candidate would read `chatCompletions: "unknown"` and
  // the (correctly strict) capability gate would exclude the entire registry.
  // The strictness still applies to capabilities the catalog does NOT
  // establish — tool calls, JSON schema, vision — which stay `unknown` and
  // therefore cannot satisfy a request that requires them.
  if (profile.chatCompletions !== false) {
    if (catalogEntry?.state === "validated") {
      profile.chatCompletions = true;
      if (source === "unknown" || source === "provider_model_metadata") {
        source = "bounded_capability_probe";
      }
    } else if (catalogEntry?.state === "exposed") {
      profile.chatCompletions = true;
      if (source === "unknown") {
        source = "provider_model_metadata";
      }
    }
  }

  return {
    ...profile,
    capabilitySource: source,
    capabilityConfidence: SOURCE_CONFIDENCE[source] ?? "none",
    lastCapabilityValidationAt: catalogEntry?.validatedAt ?? null
  };
}

/**
 * Hard capability gate. Returns the first unmet requirement so the caller can
 * report a specific exclusion reason.
 *
 * `unknown` is treated as NOT satisfying a requirement — the whole point of
 * the gate. A capability PARAGON cannot vouch for must not be promised to a
 * caller who explicitly asked for it.
 */
export function checkRequiredCapabilities(capabilityProfile, requiredCapabilities = []) {
  for (const requirement of requiredCapabilities) {
    const value = capabilityProfile?.[requirement];
    if (value === true) {
      continue;
    }
    return {
      ok: false,
      requirement,
      observed: value ?? "absent",
      reasonCode:
        requirement === "chatCompletions"
          ? "routing.chatCapabilityUnsupported"
          : `routing.capabilityUnsupported.${requirement}`
    };
  }
  return { ok: true };
}
