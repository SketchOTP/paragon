// There is no static fallback chain. Every attempt comes from the per-request
// ranked attempt plan built over the eligible catalog
// (src/routing/automaticRouting.js), and an empty eligible set is a bounded
// 503 rather than a silently weakened constraint.
//
// PARAGON-D-004E removed the last remnants of the old dispatch path from the
// schema entirely: routing.defaultProvider, routing.fallbackChain,
// routing.taskRoutes and providers.*.model no longer exist, so there is no
// configured value left that could reintroduce an unvalidated route.

export const CLIENT_ERROR_MESSAGE =
  "I couldn't complete that request right now. Please try again in a moment.";

const NOISE_PATTERNS = [
  /you're out of extra usage[^\n]*/gi,
  /out of extra usage · resets[^\n]*/gi,
  /(?:claude|codex|cursor-agent|agy) exited with code \d+:?/gi,
  /(?:routerbot|paragon): all providers failed[^\n]*/gi
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

export function formatProviderError(error) {
  const parts = [];
  if (error.code != null) {
    parts.push(`exited ${error.code}`);
  }
  if (error.message) {
    parts.push(error.message);
  }
  const detail = (error.stderr || error.stdout || "").trim();
  if (detail && !parts.includes(detail)) {
    parts.push(detail.slice(0, 500));
  }
  return parts.join(": ") || "provider failed";
}

export function allProvidersFailedMessage(attempts, lastError) {
  return `All providers failed (${attempts.map((a) => a.name).join(" → ")}): ${formatProviderError(lastError)}`;
}
