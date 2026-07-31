/** Stable identity for one provider/model/reasoning/execution expert. */
export function executionMethodFor(provider, isHttpProvider) {
  return isHttpProvider ? "openai_compatible_http" : "native_agent_cli";
}

export function expertTupleId({ provider, canonicalModelId, reasoningProfile, executionMethod }) {
  return [provider, canonicalModelId || "default", reasoningProfile || "unknown", executionMethod]
    .map((part) => String(part).replaceAll("|", "%7C"))
    .join("|");
}
