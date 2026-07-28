/**
 * Conservative, offline context-size estimation. No tokenizer dependency —
 * this is the "always available" fallback the directive requires; a
 * provider-specific tokenizer can be layered in later without changing the
 * shape of the result.
 */

const CHARS_PER_TOKEN_ESTIMATE = 3.5;

function messageCharCount(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (typeof part === "string") return sum + part.length;
      if (part?.type === "text") return sum + (part.text ?? "").length;
      return sum + JSON.stringify(part ?? "").length;
    }, 0);
  }
  if (content == null) {
    return 0;
  }
  return JSON.stringify(content).length;
}

function estimateTokensFromChars(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Estimates the size of an OpenAI-compatible chat completion request
 * before it is dispatched to a provider.
 *
 * @param {object} body - the parsed request body (messages, tools, ...)
 * @returns {object} estimate with method, confidence, and contributing detail
 */
export function estimateRequestContext(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  const perMessageChars = messages.map((message, index) => ({
    index,
    role: message?.role ?? "user",
    chars: messageCharCount(message)
  }));

  const messageChars = perMessageChars.reduce((sum, m) => sum + m.chars, 0);
  const toolSchemaChars = tools.reduce((sum, tool) => sum + JSON.stringify(tool ?? "").length, 0);

  const totalChars = messageChars + toolSchemaChars;
  const estimatedInputTokens = estimateTokensFromChars(totalChars);
  const toolSchemaContributionTokens = estimateTokensFromChars(toolSchemaChars);

  const largestContributingMessages = perMessageChars
    .slice()
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 3)
    .map(({ index, role, chars }) => ({ index, role, estimatedTokens: estimateTokensFromChars(chars) }));

  return {
    estimatedInputTokens,
    method: "char-heuristic",
    confidence: "low",
    isExact: false,
    characterCount: totalChars,
    messageCount: messages.length,
    toolSchemaContributionTokens,
    largestContributingMessages
  };
}

/** Bounded, non-exact response-size estimate from provider output text. */
export function estimateResponseSize(text) {
  const chars = String(text ?? "").length;
  return {
    estimatedOutputTokens: estimateTokensFromChars(chars),
    method: "char-heuristic",
    confidence: "low",
    isExact: false,
    characterCount: chars
  };
}
