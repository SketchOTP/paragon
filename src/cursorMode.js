import { normalizeContent } from "./prompt.js";
import { looksLikeResponsesPayload } from "./responsesFormat.js";

export const CURSOR_MODES = ["ask", "plan", "agent", "debug", "multitask"];

const MODE_ALIASES = {
  composer: "agent",
  agent_mode: "agent",
  multi: "multitask",
  multitasking: "multitask"
};

const METADATA_MODE_KEYS = [
  "mode",
  "cursor_mode",
  "composer_mode",
  "chat_mode",
  "interaction_mode",
  "conversation_mode"
];

const HEADER_MODE_KEYS = [
  "x-cursor-mode",
  "x-cursor-chat-mode",
  "x-chat-mode",
  "x-interaction-mode"
];

export function normalizeCursorMode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const mode = value.toLowerCase().trim();
  if (CURSOR_MODES.includes(mode)) {
    return mode;
  }
  return MODE_ALIASES[mode] ?? null;
}

export function extractCursorMode(body, headers = {}) {
  if (!body || typeof body !== "object") {
    return null;
  }

  for (const key of HEADER_MODE_KEYS) {
    const fromHeader = normalizeCursorMode(headers[key]);
    if (fromHeader) {
      return fromHeader;
    }
  }

  const direct = normalizeCursorMode(body.mode);
  if (direct) {
    return direct;
  }

  const metadata = body.metadata;
  if (metadata && typeof metadata === "object") {
    for (const key of METADATA_MODE_KEYS) {
      const fromMeta = normalizeCursorMode(metadata[key]);
      if (fromMeta) {
        return fromMeta;
      }
    }
    if (metadata.multitask === true || metadata.is_multitask === true) {
      return "multitask";
    }
  }

  const fromMessages = modeFromMessages(body.messages);
  if (fromMessages) {
    return fromMessages;
  }

  if (looksLikeMultitaskPayload(body)) {
    return "multitask";
  }
  if (looksLikeDebugPayload(body)) {
    return "debug";
  }
  if (looksLikePlanPayload(body)) {
    return "plan";
  }
  if (looksLikeAgentPayload(body)) {
    return "agent";
  }

  return null;
}

function modeFromMessages(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const message of messages) {
    if (message?.role !== "system" && message?.role !== "developer") {
      continue;
    }
    const text = normalizeContent(message.content);
    if (/\bplan mode\b/i.test(text) || /\bplanning mode\b/i.test(text)) {
      return "plan";
    }
    if (/\bdebug mode\b/i.test(text)) {
      return "debug";
    }
    if (/\bagent mode\b/i.test(text) || /\bcomposer mode\b/i.test(text)) {
      return "agent";
    }
    if (/\bask mode\b/i.test(text) || /\bq&a mode\b/i.test(text)) {
      return "ask";
    }
  }
  return null;
}

function looksLikeAgentPayload(body) {
  if (!looksLikeResponsesPayload(body)) {
    return false;
  }
  if (body.parallel_tool_calls || (Array.isArray(body.tools) && body.tools.length > 0)) {
    return true;
  }
  if (Array.isArray(body.include) && body.include.some((item) => String(item).includes("reasoning"))) {
    return true;
  }
  return Boolean(body.reasoning);
}

function looksLikeMultitaskPayload(body) {
  const metadata = body.metadata;
  if (metadata?.subagents || metadata?.parallel_agents || metadata?.worker_count) {
    return true;
  }
  if (Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === "delegate_task")) {
    return true;
  }
  return false;
}

function looksLikeDebugPayload(body) {
  const text = [
    typeof body.instructions === "string" ? body.instructions : "",
    promptFromInput(body.input)
  ].join("\n");
  return /\b(debug|stack trace|crash|exception|segfault|breakpoint|root cause)\b/i.test(text);
}

function looksLikePlanPayload(body) {
  const text = [
    typeof body.instructions === "string" ? body.instructions : "",
    promptFromInput(body.input)
  ].join("\n");
  return /\b(plan mode|planning mode|create a plan|step-by-step plan|implementation plan|you are planning)\b/i.test(
    text
  );
}

function promptFromInput(input) {
  if (typeof input === "string") {
    return input;
  }
  if (!Array.isArray(input)) {
    return "";
  }
  return input
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item?.content && typeof item.content === "string") {
        return item.content;
      }
      return JSON.stringify(item);
    })
    .join("\n");
}

export function cursorModeToCliArgs(cursorMode) {
  const base = ["--print", "--trust"];
  switch (cursorMode) {
    case "plan":
      return [...base, "--mode", "plan"];
    case "ask":
      return [...base, "--mode", "ask"];
    case "debug":
      return [...base, "--mode", "ask"];
    case "agent":
    case "multitask":
      return [...base, "--force"];
    default:
      return [...base, "--mode", "ask"];
  }
}
