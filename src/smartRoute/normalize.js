import { normalizeContent } from "../prompt.js";

export function normalizeRequest(body, headers, config) {
  const messages = body?.messages ?? [];
  const prompt = messages.length ? messagesToNormalizedPrompt(messages) : extractInputPrompt(body);
  const exposedModel = config?.server?.exposedModel ?? "paragon";
  const requestedModel = typeof body?.model === "string" ? body.model.trim() : "";

  return {
    body,
    headers,
    messages,
    prompt,
    requestedModel,
    userSelectedModel: Boolean(requestedModel && requestedModel !== exposedModel),
    hasImage: detectVision(messages, body),
    requiresTools: detectTools(body),
    requiresStrictJson: detectStrictJson(body),
    estimatedTokens: estimateTokens(prompt, messages),
    containsSensitiveData: detectSensitive(prompt),
    stream: Boolean(body?.stream)
  };
}

function messagesToNormalizedPrompt(messages) {
  return messages
    .map((message) => {
      const role = message.role ?? "user";
      const content = normalizeContent(message.content);
      return `${role.toUpperCase()}:\n${content}`;
    })
    .join("\n\n");
}

function extractInputPrompt(body) {
  if (typeof body?.input === "string") {
    return body.input;
  }
  if (Array.isArray(body?.input)) {
    return body.input
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.content) return normalizeContent(item.content);
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return "";
}

function detectVision(messages, body) {
  for (const message of messages) {
    const content = message?.content;
    if (Array.isArray(content)) {
      if (content.some((part) => part?.type === "image_url" || part?.type === "image")) {
        return true;
      }
    }
  }
  if (body?.modalities?.includes?.("image")) {
    return true;
  }
  return false;
}

function detectTools(body) {
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    return true;
  }
  if (body?.tool_choice && body.tool_choice !== "none") {
    return true;
  }
  return false;
}

function detectStrictJson(body) {
  if (body?.response_format?.type === "json_object" || body?.response_format?.type === "json_schema") {
    return true;
  }
  return false;
}

function estimateTokens(prompt, messages) {
  let chars = prompt.length;
  for (const message of messages) {
    chars += JSON.stringify(message.tool_calls ?? []).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

const SENSITIVE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\bssn\b/i,
  /\bpassword\s*[:=]/i,
  /\bapi[_-]?key\s*[:=]/i,
  /\bsecret\s*[:=]/i
];

function detectSensitive(text) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
