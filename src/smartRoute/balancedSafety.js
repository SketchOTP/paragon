import { TIER_RANK } from "./constants.js";
import { lookupProviderEntry } from "./shadowReport.js";

const PREMIUM_MIN_TASK_TYPES = new Set(["architecture", "high_stakes"]);
const HARD_TASK_TYPES = new Set(["architecture", "research", "code_debug"]);

const TASK_TYPE_TO_ROUTE_KEY = {
  code_debug: "debug",
  architecture: "plan",
  research: "plan",
  chat: "ask",
  rewrite: "ask",
  summarize: "explain",
  extract: "quick",
  code: "code",
  high_stakes: "plan",
  math: "ask"
};

export function resolveLegacyProviderForTaskType(taskType, config) {
  const routes = config?.routing?.taskRoutes ?? {};
  const routeKey = TASK_TYPE_TO_ROUTE_KEY[taskType] ?? taskType;
  return routes[routeKey] ?? config?.routing?.defaultProvider ?? "cursor";
}

export function enforceBalancedSafety(selected, candidates, decision, config, registry, settings) {
  const mode = settings?.mode ?? config?.routing?.smartRoute?.mode ?? "shadow_test";
  if (mode !== "balanced") {
    return { selected, adjusted: false, reasons: [] };
  }

  if (!selected || !decision || !candidates?.length) {
    return { selected, adjusted: false, reasons: [] };
  }

  const reasons = [];
  let minTierRank = 0;
  const taskType = decision.task_type ?? "unknown";
  const complexity = decision.complexity ?? 0;
  const risk = decision.risk ?? 0;

  if (PREMIUM_MIN_TASK_TYPES.has(taskType) || risk >= 4) {
    minTierRank = Math.max(minTierRank, TIER_RANK.premium);
    reasons.push("premium_minimum");
  }

  if (complexity >= 4 && HARD_TASK_TYPES.has(taskType)) {
    const legacyProvider = resolveLegacyProviderForTaskType(taskType, config);
    const legacyEntry = lookupProviderEntry(registry, legacyProvider);
    const legacyRank = TIER_RANK[legacyEntry?.tier ?? "mid"] ?? 2;
    minTierRank = Math.max(minTierRank, legacyRank);
    reasons.push("hard_task_legacy_tier_floor");
  }

  const selectedRank = TIER_RANK[selected.tier] ?? 0;
  if (selectedRank >= minTierRank) {
    return { selected, adjusted: false, reasons };
  }

  const capable = candidates.filter((entry) => (TIER_RANK[entry.tier] ?? 0) >= minTierRank);
  const pool = capable.length ? capable : candidates;
  const upgraded = [...pool].sort(
    (a, b) =>
      (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) ||
      (b.routing?.priority ?? 0) - (a.routing?.priority ?? 0)
  )[0];

  return {
    selected: upgraded ?? selected,
    adjusted: upgraded?.id !== selected.id,
    reasons: capable.length ? reasons : [...reasons, "best_available_tier"]
  };
}
