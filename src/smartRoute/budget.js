import { estimateCost } from "./registry.js";
import { readAllDecisions } from "./decisionLog.js";

export function getDailySpend(decisions, day = new Date()) {
  const dayKey = day.toISOString().slice(0, 10);
  let total = 0;
  let premium = 0;

  for (const row of decisions) {
    const rowDay = (row.timestamp ?? "").slice(0, 10);
    if (rowDay !== dayKey) {
      continue;
    }
    const cost = row.cost_estimate ?? row.smart_cost_estimate ?? 0;
    total += cost;
    const tier = row.selected_tier ?? row.smart_tier;
    if (tier === "premium") {
      premium += cost;
    }
  }

  return { total, premium, day: dayKey };
}

export function checkBudget(settings, estimatedCost, context = {}) {
  const budget = settings ?? {};
  const result = {
    allowed: true,
    reason: null,
    capped_tier: null
  };

  if (
    typeof budget.maxSingleRequestUsd === "number" &&
    estimatedCost > budget.maxSingleRequestUsd
  ) {
    result.allowed = false;
    result.reason = "max_single_request_exceeded";
    return result;
  }

  const daily = getDailySpend(context.decisions ?? []);
  if (
    typeof budget.dailyBudgetUsd === "number" &&
    daily.total + estimatedCost > budget.dailyBudgetUsd
  ) {
    result.allowed = false;
    result.reason = "daily_budget_exceeded";
    return result;
  }

  const complexity = context.complexity ?? 0;
  const risk = context.risk ?? 0;
  const isHighStakes = complexity >= 4 || risk >= 4;

  if (
    typeof budget.premiumBudgetUsd === "number" &&
    context.tier === "premium" &&
    daily.premium + estimatedCost > budget.premiumBudgetUsd &&
    !isHighStakes
  ) {
    result.allowed = true;
    result.reason = "premium_budget_exhausted";
    result.capped_tier = "mid";
  }

  return result;
}

export async function loadBudgetContext() {
  const decisions = await readAllDecisions();
  return { decisions };
}

export function estimateRequestCostForBudget(entry, inputTokens, outputTokens) {
  if (!entry) {
    return 0;
  }
  return estimateCost(entry, inputTokens, outputTokens);
}
