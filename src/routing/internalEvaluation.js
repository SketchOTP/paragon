export const EVALUATION_FAMILIES = Object.freeze(["simple_code", "bug_repair", "repository_edit", "tool_invocation", "tool_continuation", "json_schema", "factual", "architecture", "long_context", "data_analysis", "documentation"]);
export function availabilityAcceptanceProbe(result) { return { kind: "availability_acceptance_probe", available: Boolean(result), passed: Boolean(result) }; }
export function validateEvaluationArtifact({ family, output, expected, schema, workspaceRoot, artifactPath } = {}) {
  if (family === "json_schema") { try { const value = JSON.parse(output); for (const required of schema?.required ?? []) if (!(required in value)) throw new Error(`missing required property ${required}`); return { passed: true, validator: "json_schema" }; } catch (error) { return { passed: false, validator: "json_schema", error: error.message }; } }
  if (expected != null) return { passed: output === expected, validator: "exact_match" };
  if (artifactPath && workspaceRoot && !artifactPath.startsWith(workspaceRoot)) return { passed: false, validator: "workspace_boundary" };
  return { passed: Boolean(output), validator: "non_empty" };
}
export function summarizeEvaluation(records = []) { const attempts = records.length; const successes = records.filter((r) => r.passed).length; return { attempts, successes, firstPassRate: attempts ? successes / attempts : null, eventualPassRate: attempts ? successes / attempts : null }; }
