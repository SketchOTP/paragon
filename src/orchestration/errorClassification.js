import { redactSecrets, boundedPreview } from "./redaction.js";

export const ERROR_CLASSIFICATIONS = [
  "AUTHENTICATION",
  "RATE_LIMIT",
  "TIMEOUT",
  "PROCESS_EXIT",
  "BROKEN_PIPE",
  "NETWORK",
  "MALFORMED_RESPONSE",
  "CANCELLED",
  "UNKNOWN"
];

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]);

/**
 * Maps an arbitrary provider/process error to one of the bounded
 * classifications above. Never returns raw error text — callers that also
 * want a diagnostic should use boundedDiagnostic() alongside this.
 */
export function classifyError(error) {
  if (!error) {
    return "UNKNOWN";
  }
  const code = error.code;
  const message = String(error.message ?? "").toLowerCase();

  if (code === "EPIPE" || code === "BROKEN_PIPE") {
    return "BROKEN_PIPE";
  }
  if (error.cancelled || message.includes("cancel")) {
    return "CANCELLED";
  }
  if (error.timeout || message.includes("timed out") || message.includes("timeout")) {
    return "TIMEOUT";
  }
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return "NETWORK";
  }
  if (message.includes("network") || message.includes("fetch failed")) {
    return "NETWORK";
  }
  if (
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("not logged in") ||
    message.includes("401")
  ) {
    return "AUTHENTICATION";
  }
  if (message.includes("rate limit") || message.includes("429") || message.includes("too many requests")) {
    return "RATE_LIMIT";
  }
  if (message.includes("unexpected token") || message.includes("json") || message.includes("malformed")) {
    return "MALFORMED_RESPONSE";
  }
  if (typeof code === "number" || /exited with code/i.test(message) || /exited \d/i.test(message)) {
    return "PROCESS_EXIT";
  }
  return "UNKNOWN";
}

/** Bounded, redacted diagnostic string — never the full raw error, and never a substitute for classification. */
export function boundedDiagnostic(error, maxChars = 200) {
  if (!error) {
    return null;
  }
  return boundedPreview(redactSecrets(String(error.message ?? "")), maxChars);
}
