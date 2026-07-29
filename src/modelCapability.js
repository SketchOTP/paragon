/**
 * Minimum chat-completion capability gate (PARAGON-D-004C1, P0-5).
 *
 * PARAGON's only public surface is `/v1/chat/completions`, so a model that
 * cannot serve a chat completion must never enter the routable registry —
 * regardless of what the provider's catalog listed. Before this gate,
 * `buildModelRegistry()` labeled every discovered model
 * `coding/tools/streaming: true`, which let LM Studio's embedding models
 * (`jina-embeddings-v5-text-small-retrieval`,
 * `text-embedding-nomic-embed-text-v1.5`) become routing candidates for
 * chat requests they can never fulfil.
 *
 * Scope note: this is deliberately a *minimum* gate — `chatCompletions`
 * only. Full per-model tool-call / JSON-schema / multimodal / reasoning
 * capability profiles are PARAGON-D-004D scope and are NOT inferred here.
 * Anything this module cannot positively classify as non-chat is left
 * `unknown`, and `unknown` never becomes `true` on its own for an
 * unassessed provider (see buildModelRegistry).
 */

/** Sentinel for "let the provider pick its own model" (empty --model / omitted `model` field). */
export const PROVIDER_DEFAULT_MODEL_ID = "__provider_default__";

export function isProviderDefaultId(modelId) {
  return modelId === PROVIDER_DEFAULT_MODEL_ID;
}

/**
 * Provider metadata values that positively identify a non-chat model.
 * OpenAI-compatible servers are inconsistent here (`type`, `object`, and
 * `task` are all used in the wild), so every field we understand is
 * checked and anything unrecognized is ignored rather than guessed at.
 */
const NON_CHAT_METADATA_VALUES = new Set([
  "embedding",
  "embeddings",
  "text-embedding",
  "rerank",
  "reranker",
  "reranking",
  "moderation",
  "transcription",
  "speech",
  "text-to-speech",
  "speech-to-text",
  "image",
  "image-generation",
  "vision-encoder"
]);

/**
 * Conservative, explicit non-chat id patterns. Every entry is anchored on a
 * word/segment boundary rather than bare substring containment, so a chat
 * model that merely happens to contain one of these letter sequences is not
 * caught. Kept deliberately narrow: a false negative here just means a
 * useless model may be tried once and fail (and the catalog then records
 * the rejection), whereas a false positive would silently delete a working
 * chat model from routing.
 */
const NON_CHAT_ID_PATTERNS = [
  /(^|[-_/.])embed(ding|dings)?([-_/.]|$)/i,
  /(^|[-_/.])embeddings?([-_/.]|$)/i,
  /(^|[-_/.])rerank(er|ing)?([-_/.]|$)/i,
  /(^|[-_/.])moderation([-_/.]|$)/i,
  /(^|[-_/.])whisper([-_/.]|$)/i,
  /(^|[-_/.])tts([-_/.]|$)/i,
  /(^|[-_/.])stt([-_/.]|$)/i,
  /(^|[-_/.])dall-?e([-_/.]|$)/i,
  /(^|[-_/.])stable-?diffusion([-_/.]|$)/i,
  /(^|[-_/.])sdxl([-_/.]|$)/i,
  /(^|[-_/.])clip([-_/.]|$)/i
];

/**
 * @returns {"supported"|"unsupported"|"unknown"} chat-completion support.
 *   "unsupported" is only ever returned on positive evidence (provider
 *   metadata or an explicit id pattern) — never on absence of evidence.
 */
export function classifyChatCapability({ modelId, metadata } = {}) {
  if (isProviderDefaultId(modelId)) {
    // A validated provider-default route is by construction a chat route —
    // it is only ever created by a successful chat-completion probe.
    return "supported";
  }

  const metaValues = [metadata?.type, metadata?.task, metadata?.object, metadata?.capability]
    .filter((v) => typeof v === "string")
    .map((v) => v.trim().toLowerCase());
  for (const value of metaValues) {
    if (NON_CHAT_METADATA_VALUES.has(value)) {
      return "unsupported";
    }
  }

  const id = String(modelId ?? "");
  if (!id) {
    return "unknown";
  }
  for (const pattern of NON_CHAT_ID_PATTERNS) {
    if (pattern.test(id)) {
      return "unsupported";
    }
  }

  return "unknown";
}

/** True only when the model is not positively identified as non-chat. */
export function supportsChatCompletions(args) {
  return classifyChatCapability(args) !== "unsupported";
}
