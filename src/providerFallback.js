/** After the routed provider fails, try these in order (must be enabled). */

export function buildProviderAttempts(config, primary) {
  const chain = config.routing.fallbackChain ?? ["codex", "cursor"];
  const order = [primary, ...chain.filter((name) => name !== primary)];
  const seen = new Set();
  const attempts = [];

  for (const name of order) {
    if (seen.has(name) || !config.providers[name]?.enabled) {
      continue;
    }
    seen.add(name);
    attempts.push({
      name,
      config: config.providers[name]
    });
  }

  return attempts;
}

export const CLIENT_ERROR_MESSAGE =
  "I couldn't complete that request right now. Please try again in a moment.";

const NOISE_PATTERNS = [
  /you're out of extra usage[^\n]*/gi,
  /out of extra usage · resets[^\n]*/gi,
  /(?:claude|codex|cursor-agent|agy) exited with code \d+:?/gi,
  /(?:routerbot|paragon): all providers failed[^\n]*/gi,
  /Warning: 256-color support not detected[^\n]*/gi
];

/** Strip provider billing/errors from text sent to Cursor (dashboard logs stay verbose). */
export function sanitizeAssistantContent(text) {
  if (!text) {
    return "";
  }
  let cleaned = text;
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

/** ponytail: CLI tools echo prompts/banners in stderr — keep the actionable line only. */
export function summarizeProviderStderr(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const codexError = trimmed.match(/^ERROR:\s*.+$/m);
  if (codexError) {
    return codexError[0];
  }

  const usageLimit = trimmed.match(/you(?:'|')ve hit your [^\n]+/i);
  if (usageLimit) {
    return usageLimit[0];
  }

  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^(ERROR:|error:|fatal:)/i.test(line)) {
      return line;
    }
  }

  return trimmed.slice(0, 200);
}

export function formatProviderError(error) {
  const raw = (error.stderr || error.stdout || error.message || "").trim();
  const detail = summarizeProviderStderr(raw);
  const parts = [];
  if (error.code != null) {
    parts.push(`exited ${error.code}`);
  }
  if (detail) {
    parts.push(detail);
  }
  return parts.join(": ") || "provider failed";
}

export function allProvidersFailedMessage(attempts, lastError) {
  return `All providers failed (${attempts.map((a) => a.name).join(" → ")}): ${formatProviderError(lastError)}`;
}
