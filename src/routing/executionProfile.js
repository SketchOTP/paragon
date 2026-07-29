/**
 * Model identity vs execution profile (PARAGON-D-004D, Phase 1).
 *
 *   model identity  ≠  reasoning profile  ≠  speed profile
 *
 * A provider model id can encode three independent things in one opaque
 * string. Ranking treated them as one, so `gpt-5.6-sol-max` and
 * `gpt-5.6-sol-low` were economically indistinguishable to the scorer even
 * though the former can burn several times the reasoning tokens.
 *
 * Parsing is **provider-keyed and evidence-based only**. There is no generic
 * suffix stripping, because the same token means different things per
 * provider — verified against the live production catalog:
 *
 *   cursor       gpt-5.6-sol-max      -> `max` is a reasoning-effort modifier
 *   codex        gpt-5.1-codex-max    -> `max` is part of the model identity
 *   antigravity  gemini-3.6-flash-high-> `flash` is identity, `high` is effort
 *   claude       claude-opus-4-8      -> no effort encoding at all
 *
 * A provider with no declared grammar keeps its complete id as
 * canonicalModelId with reasoningEffort/speedMode `unknown`. Nothing is
 * inferred.
 */

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "unknown"];
export const SPEED_MODES = ["standard", "fast", "priority", "unknown"];

/**
 * Monotonic ordinal for reasoning effort. Used only for ordering and for the
 * transparent prior in costModel.js — deliberately NOT a token multiplier.
 * `unknown` returns null so callers must handle absence explicitly rather
 * than silently treating it as some middle value.
 */
export function reasoningEffortRank(effort) {
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const index = order.indexOf(effort);
  return index === -1 ? null : index;
}

/**
 * Per-provider suffix grammars, each derived from the provider's real
 * catalog rather than assumed. `effortTokens` and `speedTokens` are only
 * ever stripped from the *end* of the id, in the declared order, so an
 * identity token that happens to share a name is never touched mid-string.
 */
const PROVIDER_GRAMMARS = {
  /**
   * cursor: `<base>[-thinking][-<effort>][-fast]`
   *
   * Evidence (live `cursor-agent models`): gpt-5.6-sol-{none,low,medium,
   * high,xhigh,max}[-fast], claude-opus-5[-thinking]-{low..max}[-fast],
   * cursor-grok-4.5-{low,medium,high}[-fast], composer-2.5[-fast], auto.
   *
   * `thinking` is a model *variant*, not an effort: cursor exposes both
   * `claude-opus-5-high` and `claude-opus-5-thinking-high`, so collapsing
   * them would merge two distinct executions.
   */
  cursor: {
    speedTokens: { fast: "fast" },
    effortTokens: {
      none: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max"
    },
    variantTokens: { thinking: "thinking" },
    // No effort suffix present means the provider's own default, which
    // cursor does not document — recorded as unknown rather than guessed.
    defaultEffort: "unknown",
    defaultSpeed: "standard"
  },

  /**
   * antigravity: `<base>-<effort>` with effort in {low, medium, high}.
   *
   * Evidence (live `agy models`): gemini-3.6-flash-{low,medium,high},
   * gemini-3.1-pro-{low,high}. `flash` and `pro` are Google model identity
   * and must survive parsing — the exact case the directive calls out.
   */
  antigravity: {
    speedTokens: {},
    effortTokens: { low: "low", medium: "medium", high: "high" },
    variantTokens: {},
    defaultEffort: "unknown",
    defaultSpeed: "standard"
  }

  // codex: deliberately absent. `gpt-5.1-codex-max` and `gpt-5.4-mini` are
  // distinct models, not effort settings; codex sets reasoning effort
  // through its own config, not the model id. Parsing a grammar here would
  // corrupt real model identities.
  //
  // claude: deliberately absent. Model ids carry identity plus an optional
  // release date and encode no effort. (Date handling belongs to benchmark
  // canonicalization, not to execution profiling.)
};

/** True when the provider has a declared, evidence-backed suffix grammar. */
export function hasProviderGrammar(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_GRAMMARS, provider);
}

export function providerGrammarSummary() {
  const summary = {};
  for (const [provider, g] of Object.entries(PROVIDER_GRAMMARS)) {
    summary[provider] = {
      effortTokens: Object.keys(g.effortTokens),
      speedTokens: Object.keys(g.speedTokens),
      variantTokens: Object.keys(g.variantTokens)
    };
  }
  return summary;
}

function splitTrailingToken(id, tokenMap) {
  for (const [token, value] of Object.entries(tokenMap)) {
    const suffix = `-${token}`;
    if (id.length > suffix.length && id.endsWith(suffix)) {
      return { rest: id.slice(0, -suffix.length), value };
    }
  }
  return null;
}

/**
 * Parses a provider model id into identity + execution profile.
 *
 * @param {string} provider
 * @param {string} providerModelId
 * @param {object} [options]
 * @param {Record<string,object>} [options.explicitMappings] - operator-reviewed
 *   overrides keyed by `provider/providerModelId`, highest authority.
 * @returns {{
 *   providerModelId: string, canonicalModelId: string, modelFamily: string|null,
 *   modelVariant: string|null, reasoningEffort: string, speedMode: string,
 *   executionProfile: string, profileParseSource: string, profileParseConfidence: string
 * }}
 */
export function parseExecutionProfile(provider, providerModelId, { explicitMappings = {} } = {}) {
  const id = String(providerModelId ?? "");
  const base = {
    providerModelId: id,
    canonicalModelId: id,
    modelFamily: inferModelFamily(id),
    modelVariant: null,
    reasoningEffort: "unknown",
    speedMode: "unknown",
    executionProfile: "unknown",
    profileParseSource: "none",
    profileParseConfidence: "none"
  };
  if (!id) {
    return base;
  }

  // 1. Operator-reviewed explicit mapping wins outright.
  const explicit = explicitMappings[`${provider}/${id}`] ?? explicitMappings[id];
  if (explicit) {
    return finalize({
      ...base,
      canonicalModelId: explicit.canonicalModelId ?? id,
      modelVariant: explicit.modelVariant ?? null,
      reasoningEffort: REASONING_EFFORTS.includes(explicit.reasoningEffort) ? explicit.reasoningEffort : "unknown",
      speedMode: SPEED_MODES.includes(explicit.speedMode) ? explicit.speedMode : "unknown",
      modelFamily: explicit.modelFamily ?? base.modelFamily,
      profileParseSource: "explicit_mapping",
      profileParseConfidence: "high"
    });
  }

  // 2. Provider-declared grammar.
  const grammar = PROVIDER_GRAMMARS[provider];
  if (!grammar) {
    // No grammar: the whole id is the canonical model. Nothing stripped,
    // nothing inferred (see the codex/claude notes above).
    return finalize({
      ...base,
      profileParseSource: "no_provider_grammar",
      profileParseConfidence: "high"
    });
  }

  let rest = id;
  let speedMode = grammar.defaultSpeed;
  let reasoningEffort = grammar.defaultEffort;
  let modelVariant = null;
  let matchedAnything = false;

  // Strictly right-to-left, in grammar order: [-fast] then [-effort] then
  // [-variant]. Order matters: `...-low-fast` must yield low + fast.
  const speedMatch = splitTrailingToken(rest, grammar.speedTokens);
  if (speedMatch) {
    rest = speedMatch.rest;
    speedMode = speedMatch.value;
    matchedAnything = true;
  }

  const effortMatch = splitTrailingToken(rest, grammar.effortTokens);
  if (effortMatch) {
    rest = effortMatch.rest;
    reasoningEffort = effortMatch.value;
    matchedAnything = true;
  }

  const variantMatch = splitTrailingToken(rest, grammar.variantTokens);
  if (variantMatch) {
    rest = variantMatch.rest;
    modelVariant = variantMatch.value;
    matchedAnything = true;
  }

  return finalize({
    ...base,
    canonicalModelId: rest,
    modelFamily: inferModelFamily(rest),
    modelVariant,
    reasoningEffort,
    speedMode,
    profileParseSource: matchedAnything ? "provider_grammar" : "provider_grammar_no_suffix",
    profileParseConfidence: "high"
  });
}

function finalize(profile) {
  const parts = [];
  if (profile.modelVariant) parts.push(profile.modelVariant);
  if (profile.reasoningEffort && profile.reasoningEffort !== "unknown") parts.push(`effort:${profile.reasoningEffort}`);
  if (profile.speedMode && profile.speedMode !== "unknown") parts.push(`speed:${profile.speedMode}`);
  return {
    ...profile,
    executionProfile: parts.length ? parts.join("|") : "default"
  };
}

/**
 * Coarse family label for grouping in the dashboard and telemetry. Purely
 * descriptive — never used as a matching or eligibility input, so a wrong
 * guess here cannot affect routing.
 */
function inferModelFamily(canonicalModelId) {
  const id = String(canonicalModelId ?? "").toLowerCase();
  if (!id) return null;
  if (id.startsWith("claude-")) return "claude";
  if (id.startsWith("gpt-oss")) return "gpt-oss";
  if (id.startsWith("gpt-")) return "gpt";
  if (id.startsWith("gemini-")) return "gemini";
  if (id.startsWith("composer")) return "composer";
  if (id.includes("grok")) return "grok";
  if (id.includes("kimi")) return "kimi";
  if (id === "auto") return "auto";
  return null;
}
