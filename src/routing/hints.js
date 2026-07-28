/** Optional per-request routing hints (PARAGON-D-004). All are opt-in; absent = normal automatic routing. */

const COST_CLASSES = new Set(["economy", "standard", "premium"]);

export function extractRoutingHints(headers = {}) {
  const get = (name) => headers[name] ?? headers[name.toLowerCase()];

  const forceProvider = typeof get("x-paragon-force-provider") === "string" ? get("x-paragon-force-provider").trim() : null;
  const forceModel = typeof get("x-paragon-force-model") === "string" ? get("x-paragon-force-model").trim() : null;
  const maxCostClassRaw = get("x-paragon-max-cost-class");
  const maxCostClass = COST_CLASSES.has(maxCostClassRaw) ? maxCostClassRaw : null;
  const disableEscalation = String(get("x-paragon-disable-escalation") ?? "").toLowerCase() === "true";

  return {
    forceProvider: forceProvider || null,
    forceModel: forceModel || null,
    maxCostClass,
    disableEscalation
  };
}

/**
 * The one validation contract PARAGON can honestly check today: PARAGON is
 * a completion proxy with no test-execution loop, so "validation" cannot
 * mean running the caller's test suite. What it CAN mean, for real: did
 * the response satisfy the output-format contract the caller asked for.
 * Currently: OpenAI-style response_format json_object/json_schema.
 */
export function requiresJsonValidation(body) {
  const type = body?.response_format?.type;
  return type === "json_object" || type === "json_schema";
}

export function isValidJson(text) {
  if (!text || !text.trim()) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
