/** Versioned, deterministic task requirements used by cost-per-success routing. */
export const SUFFICIENCY_RISK_THRESHOLDS = Object.freeze({
  low: 0.78,
  normal: 0.86,
  production: 0.94,
  security_critical: 0.97
});

const has = (text, re) => re.test(text);

export function buildTaskProfileV2({ prompt = "", body = {}, estimatedInputTokens = null, hints = {} } = {}) {
  const text = String(prompt ?? "");
  const code = has(text, /\b(implement|refactor|function|class|typescript|javascript|python|endpoint|component|repository|repo)\b/i);
  const debug = has(text, /\b(debug|bug|error|exception|failing|failure|regression|root cause|crash)\b/i);
  const architecture = has(text, /\b(architect|architecture|system design|distributed|microservice|scalab|migration)\b/i);
  const editing = has(text, /\b(edit|modify|change|fix|patch|repository|repo|workspace|file|commit|run tests)\b/i);
  const toolCall = Array.isArray(body.tools) && body.tools.length > 0 || has(text, /\b(use tools?|execute|run command|terminal|browser)\b/i);
  const production = has(text, /\b(production|prod|live|customer|outage|incident|hotfix|data loss)\b/i);
  const security = has(text, /\b(security|vulnerab|exploit|injection|xss|csrf|credential|secret)\b/i);
  const complexity = has(text, /\b(entire codebase|cross[- ]system|multi[- ]service|end[- ]to[- ]end|complex|intricate|race condition)\b/i)
    ? (has(text, /\b(entire codebase|cross[- ]system|multi[- ]service|end[- ]to[- ]end)\b/i) ? "extreme" : "complex")
    : (has(text, /\b(simple|tiny|trivial|typo|one[- ]liner)\b/i) ? "trivial" : "normal");
  const risk = security ? "security_critical" : production ? "production" : complexity === "trivial" ? "low" : "normal";
  const workType = architecture ? "architecture" : debug ? "debug" : code ? "code" : has(text, /\b(document|readme|docs?)\b/i) ? "documentation" : "unknown";
  const reasoningDemand = security || complexity === "extreme" ? "maximum" : complexity === "complex" || debug ? "high" : complexity === "trivial" ? "minimal" : "medium";
  const outputContract = body?.response_format?.type === "json_schema" ? "json_schema" : body?.response_format?.type === "json_object" ? "json" : toolCall ? "tool_call" : code || debug ? "code" : "prose";
  const agenticIntensity = toolCall || editing ? (editing && toolCall ? "high" : "medium") : "none";
  const expectedToolCount = toolCall ? Math.max(1, (text.match(/\b(run|use|inspect|test|execute|call)\b/gi) ?? []).length) : 0;
  const contextRequirement = Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 50000 ? "large" : Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 4000 ? "medium" : "small";
  const latencyTarget = has(text, /\b(quick|fast|asap|interactive)\b/i) ? "interactive" : has(text, /\b(batch|overnight|no rush|thorough)\b/i) ? "batch" : "normal";
  return {
    version: 2,
    workType, domain: security ? "security" : code ? "software" : "general",
    complexity, risk, requiredCorrectness: risk === "security_critical" ? "critical" : risk === "production" ? "high" : complexity === "trivial" ? "normal" : "high",
    agenticIntensity, toolCallIntensity: toolCall ? "high" : "none", expectedToolCount,
    repositoryEditingRequired: editing, reasoningDemand, contextRequirement,
    outputLength: Number.isFinite(body?.max_tokens) ? Number(body.max_tokens) : null,
    outputContract, modality: "text", latencyTarget,
    costSensitivity: hints.maxCostClass === "economy" ? "high" : risk === "security_critical" ? "low" : "normal",
    failureTolerance: risk === "security_critical" ? "none" : risk === "production" ? "low" : "normal",
    estimatedInputTokens: Number.isFinite(estimatedInputTokens) ? estimatedInputTokens : null,
    sufficiencyThreshold: Math.max(SUFFICIENCY_RISK_THRESHOLDS[risk] ?? SUFFICIENCY_RISK_THRESHOLDS.normal, { trivial: 0.78, normal: 0.86, complex: 0.91, extreme: 0.94 }[complexity] ?? 0.86),
    profileSource: "deterministic_v2"
  };
}
