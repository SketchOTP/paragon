import { runProvider } from "../cli.js";
import { CLASSIFIER_PROMPT, TASK_TYPES, TIERS } from "./constants.js";

export async function callRoutingClassifier(normalized, config) {
  const smartRoute = config?.routing?.smartRoute ?? {};
  const providerName = smartRoute.classifierProvider ?? config.routing?.defaultProvider ?? "codex";
  const providerConfig = config?.providers?.[providerName];

  if (!providerConfig?.enabled) {
    return null;
  }

  const prompt = CLASSIFIER_PROMPT.replace("{{prompt}}", normalized.prompt.slice(0, 4000));

  try {
    const result = await runProvider(providerName, providerConfig, prompt);
    return parseClassifierResponse(result.stdout);
  } catch (error) {
    console.error("SmartRoute classifier failed:", error.message);
    return null;
  }
}

export function parseClassifierResponse(text) {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return sanitizeDecision(parsed);
  } catch {
    return null;
  }
}

function sanitizeDecision(raw) {
  const taskType = TASK_TYPES.includes(raw.task_type) ? raw.task_type : "unknown";
  const recommendedTier = TIERS.includes(raw.recommended_tier) ? raw.recommended_tier : "mid";
  const privacyLevel = ["normal", "sensitive", "local_only"].includes(raw.privacy_level)
    ? raw.privacy_level
    : "normal";

  return {
    task_type: taskType,
    complexity: clampInt(raw.complexity, 1, 5, 3),
    risk: clampInt(raw.risk, 1, 5, 2),
    needs_tools: Boolean(raw.needs_tools),
    needs_vision: Boolean(raw.needs_vision),
    needs_long_context: Boolean(raw.needs_long_context),
    needs_strict_json: Boolean(raw.needs_strict_json),
    privacy_level: privacyLevel,
    recommended_tier: recommendedTier,
    confidence: clampFloat(raw.confidence, 0, 1, 0.5),
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 240) : ""
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}
