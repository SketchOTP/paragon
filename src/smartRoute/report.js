import { buildShadowReport } from "./shadowReport.js";
import { checkCanaryRollback, readCanaryState } from "./canary.js";

export async function buildFullShadowReport(decisions, registry, config) {
  const report = buildShadowReport(decisions, registry);
  report.canary_rollback_status = config
    ? await checkCanaryRollback(config, decisions)
    : await readCanaryState();
  return report;
}
