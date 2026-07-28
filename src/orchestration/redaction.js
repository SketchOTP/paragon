import crypto from "node:crypto";

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|secret|password|credential)/i;
// Orchestration records legitimately carry token-*count* fields (estimatedInputTokens,
// tokensEstimate, ...) — only flag "token" when singular, since credential fields
// are spelled accessToken/apiToken/refreshToken, never pluralized.
const TOKEN_CREDENTIAL_PATTERN = /token(?!s)/i;

function looksLikeSecretKey(key) {
  return SECRET_KEY_PATTERN.test(key) || TOKEN_CREDENTIAL_PATTERN.test(key);
}

const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /sk-[A-Za-z0-9]{16,}/g
];

/** Recursively redacts values whose key looks credential-shaped. Never throws on cyclic-ish input. */
export function redactSecrets(value, seen = new Set()) {
  if (typeof value === "string") {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      out = out.replace(pattern, "[REDACTED]");
    }
    return out;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = looksLikeSecretKey(key) ? "[REDACTED]" : redactSecrets(val, seen);
  }
  return out;
}

/** Bounded, non-reversible fingerprint of prompt content — never store raw prompts by default. */
export function hashContent(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

export function boundedPreview(text, maxChars = 0) {
  if (!maxChars) {
    return undefined;
  }
  const str = String(text ?? "");
  return str.length > maxChars ? `${str.slice(0, maxChars)}…` : str;
}
