import { normalizeContent } from "./prompt.js";

const RESPONSE_MARKERS = [
  "previous_response_id",
  "instructions",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "truncation"
];

export function looksLikeResponsesPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if ("messages" in payload) {
    return false;
  }
  if ("input" in payload) {
    return true;
  }
  return RESPONSE_MARKERS.some((marker) => marker in payload);
}

export function sanitizeResponsesPayload(payload) {
  const sanitized = { ...payload };
  sanitized.metadata = undefined;
  sanitized.stream_options = undefined;
  return sanitized;
}

export function responsesInputToPrompt(body = {}) {
  const parts = [];

  if (body.instructions) {
    parts.push(`SYSTEM:\n${normalizeContent(body.instructions)}`);
  }

  const input = body.input;
  if (typeof input === "string") {
    parts.push(`USER:\n${input}`);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      parts.push(responsesItemToText(item));
    }
  } else if (input != null) {
    parts.push(normalizeContent(input));
  }

  return parts.filter(Boolean).join("\n\n");
}

function responsesItemToText(item) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return normalizeContent(item);
  }

  if (item.role && item.type !== "message") {
    const role = item.role ?? "user";
    return `${role.toUpperCase()}:\n${normalizeContent(item.content)}`;
  }

  const type = item.type;
  if (type === "message" || item.role) {
    const role = item.role ?? "user";
    return `${role.toUpperCase()}:\n${normalizeMessageContent(item.content)}`;
  }
  if (type === "function_call_output") {
    return `TOOL_OUTPUT:\n${normalizeContent(item.output ?? item)}`;
  }
  if (type === "function_call") {
    return `FUNCTION_CALL:\n${item.name ?? "tool"}: ${item.arguments ?? ""}`;
  }
  if (type === "custom_tool_call") {
    return `TOOL_CALL:\n${item.name ?? item.namespace ?? "custom_tool"}: ${item.input ?? ""}`;
  }
  if (type === "custom_tool_call_output") {
    return `TOOL_OUTPUT:\n${normalizeContent(item.output ?? item)}`;
  }

  return JSON.stringify(item);
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return normalizeContent(content);
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part?.type === "input_text" || part?.type === "output_text") {
        return part.text ?? "";
      }
      if (part?.type === "input_image") {
        return part.image_url?.url ? `[image:${part.image_url.url}]` : "[image]";
      }
      return normalizeContent(part);
    })
    .join("\n");
}

export function buildResponseObject({ model, content, provider, routedProvider, durationMs }) {
  const now = Math.floor(Date.now() / 1000);
  const responseId = `resp_${Date.now()}`;
  const messageId = `msg_${Date.now()}`;

  return {
    id: responseId,
    object: "response",
    created_at: now,
    status: "completed",
    model,
    output: [
      {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: content }]
      }
    ],
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    },
    routerbot: {
      durationMs,
      provider,
      routedProvider,
      fallback: provider !== routedProvider
    }
  };
}

export function responsesToChatCompletion(responsePayload) {
  const message = responsesOutputToChatMessage(responsePayload);
  const finishReason = message.tool_calls?.length ? "tool_calls" : "stop";

  return {
    id: responsePayload.id,
    object: "chat.completion",
    created: responsePayload.created_at,
    model: responsePayload.model,
    choices: [{ index: 0, finish_reason: finishReason, message }],
    usage: responsesUsageToChatUsage(responsePayload)
  };
}

export function responsesOutputToChatMessage(responsePayload) {
  const textParts = [];
  const toolCalls = [];

  for (const item of responsePayload.output ?? []) {
    const toolCall = itemToToolCall(item);
    if (toolCall) {
      toolCalls.push(toolCall);
      continue;
    }
    if (item.type !== "message") {
      continue;
    }
    for (const contentItem of item.content ?? []) {
      if (contentItem.type === "output_text") {
        textParts.push(contentItem.text ?? "");
      }
    }
  }

  const message = { role: "assistant", content: textParts.join("") };
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }
  return message;
}

function itemToToolCall(item) {
  if (item.type === "function_call") {
    return {
      id: item.call_id ?? item.id,
      type: "function",
      function: { name: item.name ?? "", arguments: item.arguments ?? "" }
    };
  }
  if (item.type === "custom_tool_call") {
    return {
      id: item.call_id ?? item.id,
      type: "function",
      function: {
        name: item.name ?? item.namespace ?? "custom_tool",
        arguments: item.input ?? ""
      }
    };
  }
  return null;
}

export function responsesUsageToChatUsage(responsePayload) {
  const usage = responsePayload.usage ?? {};
  const inputDetails = usage.input_tokens_details ?? {};
  const outputDetails = usage.output_tokens_details ?? {};

  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: inputDetails.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: outputDetails.reasoning_tokens ?? 0 }
  };
}

export function makeChatCompletionChunk({ chunkId, model, delta, finishReason = null, created, usage }) {
  const chunk = {
    id: chunkId,
    object: "chat.completion.chunk",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
  if (usage) {
    chunk.usage = usage;
  }
  return chunk;
}
