const metricFor = (task) => task?.workType === "code" || task?.workType === "debug" ? "coding_index" : task?.agenticIntensity && task.agenticIntensity !== "none" ? "agentic_index" : "intelligence_index";
export function fuseEvidence({ taskProfile, exactTuple, production, profile, artificialAnalysis, publicBenchmarks, openRouter } = {}) {
  const metric = metricFor(taskProfile);
  const values = [exactTuple, production, profile, artificialAnalysis, publicBenchmarks, openRouter].filter(Boolean);
  const selected = values.find((v) => v[metric] != null || v.successProbability != null) ?? {};
  return { metric, value: selected[metric] ?? selected.successProbability ?? null, source: selected.source ?? "prior", sources: values.map((v) => v.source).filter(Boolean), attributionRequired: values.some((v) => v.attributionRequired) };
}
