import fs from "node:fs/promises";
import { readAllDecisions } from "./decisionLog.js";
import { assertNotProductionWrite, getDataDir, PATHS } from "./dataPaths.js";
import {
  canUseSnapshotForActiveMode,
  readCurrentSnapshot
} from "./modelSnapshotStore.js";
import { getResearchStatus } from "./researchAgent/researchRefresh.js";
import { writeConfig, readConfig } from "../configStore.js";
import { addLog } from "../logStore.js";

export const DEFAULT_LIVE_GUARD = {
  enabled: true,
  minRequests: 10,
  maxHttpFailureRate: 0.1,
  maxValidationFailureRate: 0.1,
  maxProviderTimeoutRate: 0.1,
  maxExecutionMismatchRate: 0,
  maxInvalidPricingSelections: 0,
  maxNullFinalExecuted: 0,
  maxPremiumOnCheapTaskRate: 0.05,
  rollbackMode: "shadow_test"
};

const CHEAP_TASK_TYPES = new Set(["chat", "rewrite", "summarize", "extract", "extract_json", "math"]);

export function mergeLiveGuardConfig(smartRoute = {}) {
  return {
    ...DEFAULT_LIVE_GUARD,
    ...(smartRoute.liveGuard ?? {})
  };
}

export function isBalancedLiveMode(config) {
  return (config?.routing?.smartRoute?.mode ?? "shadow_test") === "balanced";
}

function statePath() {
  return PATHS.liveGuardState;
}

export async function readLiveGuardState() {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { rolled_back: false, active: false };
    }
    throw error;
  }
}

export async function writeLiveGuardState(state) {
  const path = statePath();
  assertNotProductionWrite(path);
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function activateLiveGuard(config, options = {}) {
  const snapshot = options.snapshot ?? (await readCurrentSnapshot());
  const research = options.research ?? (await getResearchStatus(config).catch(() => ({})));
  const state = {
    active: true,
    rolled_back: false,
    reason: null,
    rates: null,
    activated_at: new Date().toISOString(),
    intelligence_hash: snapshot?.intelligence_hash ?? null,
    research_hash: research?.research_hash ?? snapshot?.research_hash ?? null,
    at: null
  };
  await writeLiveGuardState(state);
  addLog({
    type: "smart_route",
    provider: "paragon",
    level: "info",
    message: `Live guard activated (balanced) hash=${(state.intelligence_hash ?? "").slice(0, 12)}`
  });
  return state;
}

export async function clearLiveGuardRollback() {
  const prev = await readLiveGuardState();
  await writeLiveGuardState({
    ...prev,
    rolled_back: false,
    reason: null,
    rates: null,
    at: null,
    active: false
  });
}

export function filterLiveDecisions(decisions, state) {
  const activatedAt = state?.activated_at ? Date.parse(state.activated_at) : 0;
  return (decisions ?? []).filter((row) => {
    if (row.mode !== "balanced") return false;
    if (!activatedAt) return true;
    const ts = Date.parse(row.timestamp ?? 0);
    return Number.isFinite(ts) ? ts >= activatedAt : true;
  });
}

export function computeLiveRates(rows, snapshot = null) {
  const total = rows.length;
  const httpFailures = rows.filter(
    (r) => r.success === false || r.execution_failed === true
  ).length;
  const validationFailures = rows.filter((r) => r.validator_result === "fail").length;
  const timeouts = rows.filter((r) => r.timeout === true).length;
  const mismatches = rows.filter((r) => r.execution_mismatch === true).length;
  const nullFinals = rows.filter(
    (r) => !r.final_executed_canonical_id && (r.execution_failed || r.success === false || r.timeout)
  ).length;
  const invalidPricing = rows.filter((r) => isInvalidPricingSelection(r, snapshot)).length;
  const premiumOnCheap = rows.filter((r) => isPremiumOnCheap(r)).length;

  const legacyCost = rows.reduce((s, r) => s + (Number(r.legacy_cost_estimate) || 0), 0);
  const actualCost = rows.reduce(
    (s, r) => s + (Number(r.actual_cost_after_fallback ?? r.smart_cost_estimate ?? r.cost_estimate) || 0),
    0
  );

  const rate = (n) => (total > 0 ? n / total : 0);

  return {
    total,
    http_failure_count: httpFailures,
    http_failure_rate: rate(httpFailures),
    validation_failure_count: validationFailures,
    validation_failure_rate: rate(validationFailures),
    timeout_count: timeouts,
    timeout_rate: rate(timeouts),
    execution_mismatch_count: mismatches,
    execution_mismatch_rate: rate(mismatches),
    null_final_executed_count: nullFinals,
    invalid_pricing_count: invalidPricing,
    premium_on_cheap_count: premiumOnCheap,
    premium_on_cheap_rate: rate(premiumOnCheap),
    estimated_cost_legacy_usd: legacyCost,
    estimated_cost_actual_usd: actualCost,
    estimated_cost_delta_usd: legacyCost - actualCost,
    provider_fallback_count: rows.filter((r) => r.provider_fallback_used).length,
    quality_escalation_count: rows.filter((r) => r.quality_escalation_used).length
  };
}

function isPremiumOnCheap(row) {
  const taskType = row.task_type ?? "unknown";
  const complexity = row.complexity ?? 99;
  const risk = row.risk ?? 99;
  if (!CHEAP_TASK_TYPES.has(taskType) || complexity > 2 || risk > 2) {
    return false;
  }
  if (row.smart_tier === "premium") return true;
  return String(row.final_executed_canonical_id ?? "").includes("opus");
}

function isInvalidPricingSelection(row, snapshot) {
  const id = row.ranking_winner_canonical_id ?? row.selected_canonical_id ?? row.final_executed_canonical_id;
  if (!id) return false;
  if (id === "cursor:auto") return true;
  const model = (snapshot?.models ?? []).find((m) => (m.canonical_id ?? m.id) === id);
  if (!model) return false;
  const pricing = model.pricing ?? {};
  return (
    pricing.pricing_status === "invalid" ||
    pricing.pricing_status === "unknown" ||
    pricing.cost_sensitive_eligible === false ||
    pricing.input_per_1m == null ||
    pricing.input_per_1m < 0
  );
}

export async function evaluateLiveGuardConditions(config, decisions = null, options = {}) {
  const guard = mergeLiveGuardConfig(config?.routing?.smartRoute ?? {});
  const state = options.state ?? (await readLiveGuardState());
  const snapshot = options.snapshot ?? (await readCurrentSnapshot());
  const rows = filterLiveDecisions(decisions ?? (await readAllDecisions()), state);
  const rates = computeLiveRates(rows, snapshot);
  const failures = [];

  // Immediate critical conditions.
  if ((guard.maxExecutionMismatchRate ?? 0) === 0) {
    if (rates.execution_mismatch_count > 0) failures.push("execution_mismatch");
  } else if (rates.execution_mismatch_rate > guard.maxExecutionMismatchRate) {
    failures.push("execution_mismatch");
  }
  if (rates.invalid_pricing_count > (guard.maxInvalidPricingSelections ?? 0)) {
    failures.push("invalid_pricing");
  }
  if (rates.null_final_executed_count > (guard.maxNullFinalExecuted ?? 0)) {
    failures.push("null_final_executed");
  }

  const gate = canUseSnapshotForActiveMode(config, snapshot);
  if (!gate.allowed) {
    failures.push("stale_snapshot");
  }

  const research = options.research ?? (await getResearchStatus(config).catch(() => null));
  if (
    state.intelligence_hash &&
    snapshot?.intelligence_hash &&
    state.intelligence_hash !== snapshot.intelligence_hash
  ) {
    failures.push("intelligence_hash_mismatch");
  }
  if (
    state.research_hash &&
    research?.research_hash &&
    state.research_hash !== research.research_hash
  ) {
    failures.push("research_hash_mismatch");
  }
  if (
    snapshot?.research_hash &&
    research?.research_hash &&
    snapshot.research_hash !== research.research_hash
  ) {
    failures.push("snapshot_research_hash_mismatch");
  }

  // Rate-based conditions after minRequests.
  if (rates.total >= (guard.minRequests ?? 10)) {
    if (rates.http_failure_rate > (guard.maxHttpFailureRate ?? 0.1)) {
      failures.push("http_failure_rate");
    }
    if (rates.validation_failure_rate > (guard.maxValidationFailureRate ?? 0.1)) {
      failures.push("validation_failure_rate");
    }
    if (rates.timeout_rate > (guard.maxProviderTimeoutRate ?? 0.1)) {
      failures.push("provider_timeout_rate");
    }
    if (rates.premium_on_cheap_rate > (guard.maxPremiumOnCheapTaskRate ?? 0.05)) {
      failures.push("premium_on_cheap_rate");
    }
  }

  return {
    failures: [...new Set(failures)],
    rates,
    rows,
    guard,
    state,
    snapshot,
    min_requests_pending: rates.total < (guard.minRequests ?? 10)
  };
}

export async function triggerLiveGuardRollback(config, reason, rates) {
  const prev = await readLiveGuardState();
  const guard = mergeLiveGuardConfig(config?.routing?.smartRoute ?? {});
  const rollbackMode = guard.rollbackMode ?? "shadow_test";
  const at = new Date().toISOString();

  const state = {
    ...prev,
    active: false,
    rolled_back: true,
    reason,
    rates,
    at
  };
  await writeLiveGuardState(state);

  const current = await readConfig();
  if ((current.routing?.smartRoute?.mode ?? "") !== rollbackMode) {
    current.routing = current.routing ?? {};
    current.routing.smartRoute = {
      ...(current.routing.smartRoute ?? {}),
      mode: rollbackMode
    };
    await writeConfig(current);
  }

  addLog({
    type: "smart_route",
    provider: "paragon",
    level: "error",
    message: `Live guard rollback → ${rollbackMode}: ${reason}`
  });

  return { state, rollbackMode, at };
}

/**
 * Evaluate live traffic and roll back to shadow_test when thresholds trip.
 */
export async function checkLiveGuardRollback(config, decisions = null) {
  const guard = mergeLiveGuardConfig(config?.routing?.smartRoute ?? {});
  const state = await readLiveGuardState();

  if (state.rolled_back) {
    return {
      triggered: true,
      active: true,
      reason: state.reason ?? "previously_rolled_back",
      rates: state.rates ?? null,
      at: state.at ?? null
    };
  }

  if (!guard.enabled || !isBalancedLiveMode(config) || !state.active) {
    return {
      triggered: false,
      active: false,
      reason: null,
      rates: null,
      at: null
    };
  }

  const evaluation = await evaluateLiveGuardConditions(config, decisions, { state });
  if (!evaluation.failures.length) {
    return {
      triggered: false,
      active: false,
      reason: null,
      rates: evaluation.rates,
      at: null,
      min_requests_pending: evaluation.min_requests_pending
    };
  }

  const reason = evaluation.failures.join(",");
  const rolled = await triggerLiveGuardRollback(config, reason, evaluation.rates);
  return {
    triggered: true,
    active: true,
    reason,
    rates: evaluation.rates,
    at: rolled.at
  };
}

export async function getLiveStatus(config, decisions = null) {
  const guard = mergeLiveGuardConfig(config?.routing?.smartRoute ?? {});
  const state = await readLiveGuardState();
  const mode = config?.routing?.smartRoute?.mode ?? "shadow_test";
  const allDecisions = decisions ?? (await readAllDecisions());
  const rows = filterLiveDecisions(allDecisions, state);
  const snapshot = await readCurrentSnapshot();
  const rates = computeLiveRates(rows, snapshot);
  const rollbackStatus = state.rolled_back
    ? "rolled_back"
    : mode === "balanced" && state.active && guard.enabled
      ? "active"
      : "inactive";

  const byTask = {};
  const bySelected = {};
  const byFinal = {};
  for (const row of rows) {
    const task = row.task_type ?? "unknown";
    byTask[task] = (byTask[task] ?? 0) + 1;
    const selected = row.selected_canonical_id ?? "null";
    bySelected[selected] = (bySelected[selected] ?? 0) + 1;
    const finalId = row.final_executed_canonical_id ?? "null";
    byFinal[finalId] = (byFinal[finalId] ?? 0) + 1;
  }

  return {
    current_mode: mode,
    live_guard: guard,
    activated_at: state.activated_at ?? null,
    requests_since_activation: rates.total,
    failure_rate: rates.http_failure_rate,
    validation_failure_rate: rates.validation_failure_rate,
    timeout_rate: rates.timeout_rate,
    execution_mismatch_count: rates.execution_mismatch_count,
    premium_on_cheap_count: rates.premium_on_cheap_count,
    invalid_pricing_count: rates.invalid_pricing_count,
    null_final_executed_count: rates.null_final_executed_count,
    estimated_cost_delta: rates.estimated_cost_delta_usd,
    estimated_cost_legacy_usd: rates.estimated_cost_legacy_usd,
    estimated_cost_actual_usd: rates.estimated_cost_actual_usd,
    provider_fallback_count: rates.provider_fallback_count,
    quality_escalation_count: rates.quality_escalation_count,
    current_rollback_status: rollbackStatus,
    last_rollback_reason: state.reason ?? null,
    last_rollback_at: state.at ?? null,
    rates,
    task_type_breakdown: byTask,
    selected_models: bySelected,
    final_executed_models: byFinal,
    intelligence_hash: state.intelligence_hash ?? snapshot?.intelligence_hash ?? null,
    min_requests_pending: rates.total < (guard.minRequests ?? 10)
  };
}

export async function buildLiveSummary(config, decisions = null) {
  const allDecisions = decisions ?? (await readAllDecisions());
  const status = await getLiveStatus(config, allDecisions);
  const state = await readLiveGuardState();
  const rows = filterLiveDecisions(allDecisions, state);

  const failureCategories = {};
  const failed = [];
  for (const row of rows) {
    const failedRow =
      row.success === false ||
      row.execution_failed === true ||
      row.validator_result === "fail" ||
      row.timeout === true ||
      row.execution_mismatch === true ||
      !row.final_executed_canonical_id;
    if (!failedRow) continue;

    const categories = [];
    if (row.execution_mismatch) categories.push("execution_mismatch");
    if (!row.final_executed_canonical_id) categories.push("null_final_executed");
    if (row.timeout) categories.push("provider_timeout");
    if (row.validator_result === "fail") {
      categories.push(row.validator_failure_category ?? "validation_failure");
    }
    if (row.execution_failed || row.success === false) {
      categories.push(row.final_error_category ?? "http_failure");
    }
    for (const cat of categories.length ? categories : ["unknown_failure"]) {
      failureCategories[cat] = (failureCategories[cat] ?? 0) + 1;
    }
    failed.push(row);
  }

  failed.sort((a, b) => Date.parse(b.timestamp ?? 0) - Date.parse(a.timestamp ?? 0));
  const lastFailed = failed.slice(0, 5).map((row) => ({
    request_id: row.request_id ?? null,
    timestamp: row.timestamp ?? null,
    task_type: row.task_type ?? null,
    selected_canonical_id: row.selected_canonical_id ?? null,
    final_executed_canonical_id: row.final_executed_canonical_id ?? null,
    validator_result: row.validator_result ?? null,
    validator_failure_category: row.validator_failure_category ?? null,
    final_error_category: row.final_error_category ?? null,
    timeout: row.timeout ?? false,
    execution_mismatch: row.execution_mismatch ?? false
  }));

  const topSelected = Object.entries(status.selected_models ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  return {
    ...status,
    top_selected_models: Object.fromEntries(topSelected),
    failure_categories: failureCategories,
    last_failed_decisions: lastFailed
  };
}

export function formatLiveSummaryText(summary) {
  const pct = (n) => `${((Number(n) || 0) * 100).toFixed(1)}%`;
  const lines = [
    "SmartRoute Live Summary",
    "=======================",
    "",
    `Mode:                       ${summary.current_mode}`,
    `Requests since activation:  ${summary.requests_since_activation ?? 0}`,
    `Rollback status:            ${summary.current_rollback_status}`,
    `Last rollback reason:       ${summary.last_rollback_reason ?? "none"}`,
    `Activated at:               ${summary.activated_at ?? "n/a"}`,
    `Intelligence hash:          ${(summary.intelligence_hash ?? "n/a").slice(0, 16)}…`,
    "",
    `HTTP failure rate:          ${pct(summary.failure_rate)}`,
    `Validation failure rate:    ${pct(summary.validation_failure_rate)}`,
    `Provider timeout rate:      ${pct(summary.timeout_rate)}`,
    `Execution mismatch:         ${summary.execution_mismatch_count ?? 0}`,
    `Premium-on-cheap:           ${summary.premium_on_cheap_count ?? 0}`,
    `Null final executed:        ${summary.null_final_executed_count ?? 0}`,
    `Invalid pricing:            ${summary.invalid_pricing_count ?? 0}`,
    `Cost delta (legacy-actual): $${Number(summary.estimated_cost_delta ?? 0).toFixed(6)}`,
    "",
    "Task breakdown:"
  ];

  const tasks = Object.entries(summary.task_type_breakdown ?? {}).sort((a, b) => b[1] - a[1]);
  if (!tasks.length) {
    lines.push("  (none yet)");
  } else {
    for (const [task, count] of tasks) {
      lines.push(`  ${task}: ${count}`);
    }
  }

  lines.push("", "Top selected models:");
  const selected = Object.entries(summary.top_selected_models ?? {}).sort((a, b) => b[1] - a[1]);
  if (!selected.length) {
    lines.push("  (none yet)");
  } else {
    for (const [id, count] of selected) {
      lines.push(`  ${id}: ${count}`);
    }
  }

  lines.push("", "Failure categories:");
  const cats = Object.entries(summary.failure_categories ?? {}).sort((a, b) => b[1] - a[1]);
  if (!cats.length) {
    lines.push("  (none)");
  } else {
    for (const [cat, count] of cats) {
      lines.push(`  ${cat}: ${count}`);
    }
  }

  lines.push("", "Last 5 failed decisions:");
  const failed = summary.last_failed_decisions ?? [];
  if (!failed.length) {
    lines.push("  (none)");
  } else {
    for (const row of failed) {
      lines.push(
        `  - ${row.request_id ?? "?"} task=${row.task_type ?? "?"} selected=${row.selected_canonical_id ?? "null"} final=${row.final_executed_canonical_id ?? "null"} val=${row.validator_failure_category ?? row.validator_result ?? "n/a"} err=${row.final_error_category ?? "n/a"}`
      );
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}
