import { TIER_RANK } from "./constants.js";
import { isSafeCheapTask, mergeSafeCheapTasks, isPremiumProvider } from "./safeCheapTasks.js";
import { estimateCost } from "./registry.js";

export const LOW_CONFIDENCE_THRESHOLD = 0.7;
export const HIGH_RISK_TASK_TYPES = ["architecture", "code_debug", "research", "high_stakes"];
export const WEAK_TIERS = new Set(["local", "cheap"]);

export function tierRank(tier) {
  return TIER_RANK[tier] ?? -1;
}

export function lookupProviderEntry(registry, provider) {
  if (!provider) {
    return null;
  }
  return registry.find((entry) => entry.provider === provider) ?? null;
}

export function estimateRowCost(row, registry, role) {
  const cached =
    role === "legacy" ? row.legacy_cost_estimate : row.smart_cost_estimate ?? row.cost_estimate;
  if (typeof cached === "number") {
    return cached;
  }

  const provider = role === "legacy" ? row.legacy_provider : row.smart_provider;
  const entry = lookupProviderEntry(registry, provider);
  if (!entry) {
    return 0;
  }

  const inputTokens = row.input_tokens_est ?? 0;
  const outputTokens = row.output_tokens_est ?? 1200;
  return estimateCost(entry, inputTokens, outputTokens);
}

export function enrichDecision(row, registry) {
  const legacyEntry = lookupProviderEntry(registry, row.legacy_provider);
  const smartEntry = lookupProviderEntry(registry, row.smart_provider);

  return {
    ...row,
    legacy_tier: row.legacy_tier ?? legacyEntry?.tier ?? null,
    smart_tier: row.smart_tier ?? smartEntry?.tier ?? null,
    legacy_cost_estimate: estimateRowCost(
      { ...row, legacy_cost_estimate: row.legacy_cost_estimate ?? null },
      registry,
      "legacy"
    ),
    smart_cost_estimate: estimateRowCost(
      { ...row, smart_cost_estimate: row.smart_cost_estimate ?? row.cost_estimate ?? null },
      registry,
      "smart"
    )
  };
}

export function detectDangerDowngrade(row) {
  const reasons = [];
  const legacyTier = row.legacy_tier;
  const smartTier = row.smart_tier;
  const complexity = row.complexity ?? 0;
  const risk = row.risk ?? 0;
  const taskType = row.task_type ?? "unknown";

  if (
    legacyTier &&
    smartTier &&
    tierRank(legacyTier) > tierRank(smartTier) &&
    complexity >= 4
  ) {
    reasons.push("legacy_tier_higher_and_complexity_high");
  }

  if (risk >= 4 && smartTier && smartTier !== "premium") {
    reasons.push("high_risk_not_premium");
  }

  if (HIGH_RISK_TASK_TYPES.includes(taskType) && WEAK_TIERS.has(smartTier)) {
    reasons.push("high_risk_task_on_weak_tier");
  }

  return {
    danger: reasons.length > 0,
    reasons
  };
}

export function isLowConfidence(row) {
  return typeof row.router_confidence === "number" && row.router_confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function isCheaperWeakerDowngrade(row) {
  if (!row.legacy_tier || !row.smart_tier) {
    return false;
  }
  return tierRank(row.legacy_tier) > tierRank(row.smart_tier);
}

export function aggregateProviderHealth(decisions) {
  const byProvider = {};

  for (const row of decisions) {
    const provider = row.selected_provider ?? row.legacy_provider;
    if (!provider) {
      continue;
    }

    if (!byProvider[provider]) {
      byProvider[provider] = {
        provider,
        total: 0,
        successes: 0,
        timeouts: 0,
        validation_failures: 0,
        fallbacks: 0,
        latency_sum_ms: 0,
        latency_count: 0,
        last_failure_at: null
      };
    }

    const stats = byProvider[provider];
    stats.total += 1;

    if (row.success !== false) {
      stats.successes += 1;
    } else if (row.timestamp) {
      stats.last_failure_at = row.timestamp;
    }

    if (row.timeout) {
      stats.timeouts += 1;
    }
    if (row.validator_result === "fail") {
      stats.validation_failures += 1;
    }
    if (row.fallback_used) {
      stats.fallbacks += 1;
    }
    if (typeof row.latency_ms === "number") {
      stats.latency_sum_ms += row.latency_ms;
      stats.latency_count += 1;
    }
  }

  return Object.values(byProvider).map((stats) => {
    const total = stats.total || 1;
    const successRate = stats.successes / total;
    const timeoutRate = stats.timeouts / total;
    const validationFailureRate = stats.validation_failures / total;
    const fallbackRate = stats.fallbacks / total;
    const avgLatencyMs = stats.latency_count ? stats.latency_sum_ms / stats.latency_count : null;
    const timeoutPenalty = timeoutRate * 0.35;
    const fallbackPenalty = fallbackRate * 0.25;
    const validationPenalty = validationFailureRate * 0.2;
    const healthScore = Math.max(
      0,
      Math.min(1, successRate - timeoutPenalty - fallbackPenalty - validationPenalty)
    );

    return {
      provider: stats.provider,
      total: stats.total,
      success_rate: round(successRate),
      timeout_rate: round(timeoutRate),
      validation_failure_rate: round(validationFailureRate),
      fallback_rate: round(fallbackRate),
      average_latency_ms: avgLatencyMs != null ? Math.round(avgLatencyMs) : null,
      last_failure_at: stats.last_failure_at,
      health_score: round(healthScore)
    };
  });
}

export function buildShadowReport(decisions, registry = []) {
  const enriched = decisions.map((row) => enrichDecision(row, registry));
  const total = enriched.length;

  if (!total) {
    return emptyReport();
  }

  let shadowMatches = 0;
  let legacyCost = 0;
  let smartCost = 0;
  let actualCostAfterFallback = 0;
  let lowConfidence = 0;
  let dangerDowngrades = 0;
  let cheaperWeaker = 0;

  const byLegacyProvider = {};
  const bySmartProvider = {};
  const byTaskType = {};
  const byTier = { legacy: {}, smart: {} };
  const topDiffs = [];
  const dangerCases = [];

  for (const row of enriched) {
    if (row.shadow_match) {
      shadowMatches += 1;
    }

    legacyCost += row.legacy_cost_estimate ?? 0;
    smartCost += row.smart_cost_estimate ?? 0;
    actualCostAfterFallback +=
      row.actual_cost_after_fallback ?? row.smart_cost_estimate ?? 0;

    if (isLowConfidence(row)) {
      lowConfidence += 1;
    }

    const danger = detectDangerDowngrade(row);
    if (danger.danger) {
      dangerDowngrades += 1;
      dangerCases.push({
        request_id: row.request_id,
        timestamp: row.timestamp,
        legacy_provider: row.legacy_provider,
        smart_provider: row.smart_provider,
        legacy_tier: row.legacy_tier,
        smart_tier: row.smart_tier,
        complexity: row.complexity,
        risk: row.risk,
        task_type: row.task_type,
        reasons: danger.reasons
      });
    }

    if (isCheaperWeakerDowngrade(row)) {
      cheaperWeaker += 1;
    }

    bumpCount(byLegacyProvider, row.legacy_provider);
    bumpCount(bySmartProvider, row.smart_provider);
    bumpCount(byTaskType, row.task_type ?? "unknown");
    bumpCount(byTier.legacy, row.legacy_tier ?? "unknown");
    bumpCount(byTier.smart, row.smart_tier ?? "unknown");

    if (!row.shadow_match) {
      topDiffs.push({
        request_id: row.request_id,
        legacy_provider: row.legacy_provider,
        smart_provider: row.smart_provider,
        legacy_tier: row.legacy_tier,
        smart_tier: row.smart_tier,
        task_type: row.task_type,
        complexity: row.complexity,
        router_confidence: row.router_confidence,
        legacy_cost_estimate: round(row.legacy_cost_estimate),
        smart_cost_estimate: round(row.smart_cost_estimate),
        danger: danger.danger
      });
    }
  }

  topDiffs.sort((a, b) => (b.legacy_cost_estimate ?? 0) - (a.legacy_cost_estimate ?? 0));

  const matchRate = shadowMatches / total;
  const diffRate = 1 - matchRate;
  const savings = legacyCost - smartCost;
  const savingsAfterFallback = legacyCost - actualCostAfterFallback;
  const falseDowngradeRate = dangerDowngrades / total;
  const lowConfidenceRate = lowConfidence / total;

  const providerHealth = aggregateProviderHealth(enriched);
  const acceptance = evaluateAcceptanceGate({
    total,
    dangerDowngrades,
    falseDowngradeRate,
    lowConfidenceRate,
    dangerCases
  });
  const canary = aggregateCanaryStats(enriched, registry);
  const executionRates = aggregateExecutionRates(enriched, registry);
  const executorAudit = buildExecutorAudit(enriched, registry);

  return {
    total_requests: total,
    shadow_matches: shadowMatches,
    shadow_diffs: total - shadowMatches,
    match_rate: round(matchRate),
    diff_rate: round(diffRate),
    estimated_cost_legacy_usd: round(legacyCost),
    estimated_cost_smart_usd: round(smartCost),
    estimated_savings_usd: round(savings),
    actual_cost_after_fallback_usd: round(actualCostAfterFallback),
    estimated_savings_after_fallback_usd: round(savingsAfterFallback),
    provider_fallback_rate: executionRates.provider_fallback_rate,
    quality_escalation_rate: executionRates.quality_escalation_rate,
    total_fallback_rate: executionRates.total_fallback_rate,
    premium_fallback_on_cheap_tasks_rate: executionRates.premium_fallback_on_cheap_tasks_rate,
    validator_failure_categories: executionRates.validator_failure_categories,
    executor_audit: executorAudit,
    cheaper_weaker_downgrades: cheaperWeaker,
    danger_downgrades: dangerDowngrades,
    low_confidence_count: lowConfidence,
    low_confidence_rate: round(lowConfidenceRate),
    false_downgrade_rate: round(falseDowngradeRate),
    by_legacy_provider: byLegacyProvider,
    by_smart_provider: bySmartProvider,
    by_task_type: byTaskType,
    by_tier: byTier,
    provider_health: providerHealth,
    top_diffs: topDiffs.slice(0, 20),
    danger_cases: dangerCases.slice(0, 50),
    acceptance_gate: acceptance,
    canary
  };
}

export function aggregateExecutionRates(decisions, registry = []) {
  const total = decisions.length || 1;
  let providerFallback = 0;
  let qualityEscalation = 0;
  let totalFallback = 0;
  let premiumOnCheap = 0;
  let cheapTaskCount = 0;
  let executionMismatch = 0;
  let validationFailures = 0;
  const validatorCategories = {};
  const safeCheap = mergeSafeCheapTasks();

  for (const row of decisions) {
    if (row.provider_fallback_used) providerFallback += 1;
    if (row.quality_escalation_used) qualityEscalation += 1;
    if (row.total_fallback_used ?? row.fallback_used) totalFallback += 1;
    if (row.execution_mismatch) executionMismatch += 1;
    if (row.validator_failure_category) {
      validationFailures += 1;
      validatorCategories[row.validator_failure_category] =
        (validatorCategories[row.validator_failure_category] ?? 0) + 1;
    }
    if (isSafeCheapTask(row, safeCheap)) {
      cheapTaskCount += 1;
      const finalProvider = row.final_executed_provider ?? row.selected_provider;
      if (isPremiumProvider(registry, finalProvider)) {
        premiumOnCheap += 1;
      }
    }
  }

  return {
    provider_fallback_rate: round(providerFallback / total),
    quality_escalation_rate: round(qualityEscalation / total),
    total_fallback_rate: round(totalFallback / total),
    execution_mismatch_rate: round(executionMismatch / total),
    execution_mismatch_count: executionMismatch,
    validation_failure_rate: round(validationFailures / total),
    validation_failure_count: validationFailures,
    premium_fallback_on_cheap_tasks_rate: round(
      cheapTaskCount ? premiumOnCheap / cheapTaskCount : 0
    ),
    validator_failure_categories: validatorCategories
  };
}

export function buildExecutorAudit(decisions, registry = []) {
  const bySmartIntended = {};
  const byFirstAttempted = {};
  const byFinalExecuted = {};
  const paths = [];

  for (const row of decisions) {
    bumpCount(bySmartIntended, row.smart_intended_provider ?? row.smart_provider);
    bumpCount(byFirstAttempted, row.first_attempted_provider);
    bumpCount(byFinalExecuted, row.final_executed_provider ?? row.selected_provider);
    paths.push({
      request_id: row.request_id,
      task_type: row.task_type,
      smart_intended_provider: row.smart_intended_provider ?? row.smart_provider,
      first_attempted_provider: row.first_attempted_provider,
      final_executed_provider: row.final_executed_provider ?? row.selected_provider,
      legacy_provider: row.legacy_provider,
      provider_switches: row.provider_switches ?? []
    });
  }

  return {
    by_smart_intended: bySmartIntended,
    by_first_attempted: byFirstAttempted,
    by_final_executed: byFinalExecuted,
    paths: paths.slice(-50)
  };
}

export function computeCanaryRates(rows) {
  const total = rows.length || 1;
  let successes = 0;
  let validationFailures = 0;
  let timeouts = 0;
  let providerFallbacks = 0;
  let qualityEscalations = 0;
  let totalFallbacks = 0;
  let thumbsDown = 0;

  for (const row of rows) {
    if (row.success !== false) successes += 1;
    if (row.validator_result === "fail") validationFailures += 1;
    if (row.timeout) timeouts += 1;
    if (row.provider_fallback_used) providerFallbacks += 1;
    if (row.quality_escalation_used) qualityEscalations += 1;
    if (row.total_fallback_used ?? row.fallback_used) totalFallbacks += 1;
    if (row.user_feedback === "thumbs_down") thumbsDown += 1;
  }

  return {
    total: rows.length,
    success_rate: successes / total,
    validation_failure_rate: validationFailures / total,
    timeout_rate: timeouts / total,
    provider_fallback_rate: providerFallbacks / total,
    quality_escalation_rate: qualityEscalations / total,
    fallback_rate: totalFallbacks / total,
    thumbs_down_rate: thumbsDown / total
  };
}

export function aggregateCanaryStats(decisions, registry = []) {
  const enriched = decisions.map((row) => enrichDecision(row, registry));
  let eligible = 0;
  let executed = 0;
  let blocked = 0;
  let executedLegacyCost = 0;
  let executedSmartCost = 0;
  const blockReasons = {};

  for (const row of enriched) {
    if (row.canary_eligible) eligible += 1;
    if (row.canary_executed) {
      executed += 1;
      executedLegacyCost += row.legacy_cost_estimate ?? 0;
      executedSmartCost += row.smart_cost_estimate ?? 0;
    }
    if (row.canary_blocked) blocked += 1;
    for (const reason of row.canary_block_reasons ?? []) {
      blockReasons[reason] = (blockReasons[reason] ?? 0) + 1;
    }
  }

  const executedRows = enriched.filter((row) => row.canary_executed);
  const rates = computeCanaryRates(executedRows);

  return {
    canary_eligible_requests: eligible,
    canary_executed_requests: executed,
    canary_blocked_requests: blocked,
    canary_block_reasons: blockReasons,
    canary_success_rate: round(rates.success_rate),
    canary_fallback_rate: round(rates.fallback_rate),
    canary_validation_failure_rate: round(rates.validation_failure_rate),
    canary_timeout_rate: round(rates.timeout_rate),
    canary_thumbs_down_rate: round(rates.thumbs_down_rate),
    canary_estimated_savings_usd: round(executedLegacyCost - executedSmartCost),
    canary_estimated_legacy_cost_usd: round(executedLegacyCost),
    canary_estimated_smart_cost_usd: round(executedSmartCost)
  };
}

export function evaluateAcceptanceGate({
  total,
  dangerDowngrades,
  falseDowngradeRate,
  lowConfidenceRate,
  dangerCases
}) {
  const checks = {
    min_requests: total >= 100,
    danger_downgrades_reviewed: dangerDowngrades === 0,
    false_downgrade_rate_under_5pct: falseDowngradeRate < 0.05,
    low_confidence_under_15pct: lowConfidenceRate < 0.15,
    no_high_risk_weak_tier: !dangerCases.some((c) =>
      c.reasons.includes("high_risk_task_on_weak_tier")
    )
  };

  return {
    ready_to_leave_shadow: Object.values(checks).every(Boolean),
    checks,
    notes: [
      "Review every danger downgrade manually before leaving Shadow Test.",
      "Include fallback cost when judging estimated savings."
    ]
  };
}

function emptyReport() {
  return {
    total_requests: 0,
    shadow_matches: 0,
    shadow_diffs: 0,
    match_rate: 0,
    diff_rate: 0,
    estimated_cost_legacy_usd: 0,
    estimated_cost_smart_usd: 0,
    estimated_savings_usd: 0,
    actual_cost_after_fallback_usd: 0,
    estimated_savings_after_fallback_usd: 0,
    provider_fallback_rate: 0,
    quality_escalation_rate: 0,
    total_fallback_rate: 0,
    premium_fallback_on_cheap_tasks_rate: 0,
    validator_failure_categories: {},
    executor_audit: {
      by_smart_intended: {},
      by_first_attempted: {},
      by_final_executed: {},
      paths: []
    },
    cheaper_weaker_downgrades: 0,
    danger_downgrades: 0,
    low_confidence_count: 0,
    low_confidence_rate: 0,
    false_downgrade_rate: 0,
    by_legacy_provider: {},
    by_smart_provider: {},
    by_task_type: {},
    by_tier: { legacy: {}, smart: {} },
    provider_health: [],
    top_diffs: [],
    danger_cases: [],
    canary: aggregateCanaryStats([]),
    acceptance_gate: evaluateAcceptanceGate({
      total: 0,
      dangerDowngrades: 0,
      falseDowngradeRate: 0,
      lowConfidenceRate: 0,
      dangerCases: []
    })
  };
}

function bumpCount(map, key) {
  const k = key ?? "unknown";
  map[k] = (map[k] ?? 0) + 1;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatReportText(report) {
  const lines = [
    "SmartRoute Shadow Evaluation Report",
    "===================================",
    "",
    `Total requests:              ${report.total_requests}`,
    `Match rate:                  ${pct(report.match_rate)}`,
    `Diff rate:                   ${pct(report.diff_rate)}`,
    `Estimated cost (legacy):     $${report.estimated_cost_legacy_usd.toFixed(4)}`,
    `Estimated cost (smart):      $${report.estimated_cost_smart_usd.toFixed(4)}`,
    `Estimated savings:           $${report.estimated_savings_usd.toFixed(4)}`,
    `Actual cost (after fallback): $${(report.actual_cost_after_fallback_usd ?? 0).toFixed(4)}`,
    `Savings (after fallback):     $${(report.estimated_savings_after_fallback_usd ?? 0).toFixed(4)}`,
    "",
    `Provider fallback rate:      ${pct(report.provider_fallback_rate ?? 0)}`,
    `Quality escalation rate:     ${pct(report.quality_escalation_rate ?? 0)}`,
    `Total fallback rate:         ${pct(report.total_fallback_rate ?? 0)}`,
    `Premium on cheap tasks:      ${pct(report.premium_fallback_on_cheap_tasks_rate ?? 0)}`,
    "",
    `Cheaper/weaker downgrades:   ${report.cheaper_weaker_downgrades}`,
    `Danger downgrades:           ${report.danger_downgrades}`,
    `Low-confidence (<0.70):      ${report.low_confidence_count} (${pct(report.low_confidence_rate)})`,
    `False downgrade rate:        ${pct(report.false_downgrade_rate)}`,
    "",
    "Legacy provider breakdown:",
    ...formatBreakdown(report.by_legacy_provider),
    "",
    "Smart provider breakdown:",
    ...formatBreakdown(report.by_smart_provider),
    "",
    "Task type breakdown:",
    ...formatBreakdown(report.by_task_type),
    "",
    "Tier breakdown (legacy / smart):",
    ...formatBreakdown(report.by_tier.legacy, "legacy"),
    ...formatBreakdown(report.by_tier.smart, "smart"),
    "",
    "Provider health:",
    ...formatProviderHealth(report.provider_health),
    "",
    "Executor audit (final executed):",
    ...formatBreakdown(report.executor_audit?.by_final_executed ?? {}),
    "",
    "Acceptance gate (leave Shadow Test):",
    ...formatAcceptance(report.acceptance_gate),
    "",
    "Canary stats:",
    ...formatCanary(report.canary),
    "",
    "Canary rollback:",
    ...formatCanaryRollback(report.canary_rollback_status)
  ];

  if (report.danger_cases.length) {
    lines.push("", "Danger cases (review these):");
    for (const row of report.danger_cases.slice(0, 10)) {
      lines.push(
        `  - ${row.request_id}: legacy=${row.legacy_provider}/${row.legacy_tier} smart=${row.smart_provider}/${row.smart_tier} complexity=${row.complexity} risk=${row.risk} task=${row.task_type} [${row.reasons.join(", ")}]`
      );
    }
  }

  if (report.top_diffs.length) {
    lines.push("", "Top legacy/smart diffs:");
    for (const row of report.top_diffs.slice(0, 10)) {
      lines.push(
        `  - legacy=${row.legacy_provider} smart=${row.smart_provider} task=${row.task_type} save=$${((row.legacy_cost_estimate ?? 0) - (row.smart_cost_estimate ?? 0)).toFixed(4)} danger=${row.danger}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatBreakdown(map, prefix = "") {
  const entries = Object.entries(map ?? {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return ["  (none)"];
  }
  return entries.map(([key, count]) => `  ${prefix ? `${prefix} ` : ""}${key}: ${count}`);
}

function formatProviderHealth(rows) {
  if (!rows.length) {
    return ["  (none)"];
  }
  return rows.map(
    (row) =>
      `  ${row.provider}: health=${row.health_score} success=${pct(row.success_rate)} timeout=${pct(row.timeout_rate)} fallback=${pct(row.fallback_rate)} avg_latency=${row.average_latency_ms ?? "n/a"}ms`
  );
}

function formatCanaryRollback(status) {
  if (!status) {
    return ["  (not checked)"];
  }
  if (status.active || status.triggered) {
    return [`  ROLLED BACK: ${status.reason ?? "threshold exceeded"}`, `  at: ${status.at ?? "unknown"}`];
  }
  return ["  Active (no rollback triggered)"];
}

function formatCanary(canary) {
  if (!canary) {
    return ["  (none)"];
  }
  return [
    `  Eligible: ${canary.canary_eligible_requests ?? 0}`,
    `  Executed: ${canary.canary_executed_requests ?? 0}`,
    `  Blocked: ${canary.canary_blocked_requests ?? 0}`,
    `  Success rate: ${pct(canary.canary_success_rate ?? 0)}`,
    `  Fallback rate: ${pct(canary.canary_fallback_rate ?? 0)}`,
    `  Est. savings: $${(canary.canary_estimated_savings_usd ?? 0).toFixed(4)}`
  ];
}

function formatAcceptance(gate) {
  const lines = [`  Ready: ${gate.ready_to_leave_shadow ? "YES" : "NO"}`];
  for (const [key, ok] of Object.entries(gate.checks)) {
    lines.push(`  ${ok ? "✓" : "✗"} ${key.replaceAll("_", " ")}`);
  }
  return lines;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

export function buildDecisionExplanation(smartDecision, legacyProvider, registry, options = {}) {
  if (!smartDecision) {
    return null;
  }

  const legacyEntry = lookupProviderEntry(registry, legacyProvider);
  const legacyCost = estimateRowCost(
    {
      legacy_provider: legacyProvider,
      smart_provider: smartDecision.provider,
      input_tokens_est: smartDecision.input_tokens_est,
      output_tokens_est: smartDecision.output_tokens_est,
      legacy_cost_estimate: null,
      smart_cost_estimate: smartDecision.cost_estimate
    },
    registry,
    "legacy"
  );
  const smartCost = smartDecision.cost_estimate ?? estimateRowCost(
    {
      smart_provider: smartDecision.provider,
      input_tokens_est: smartDecision.input_tokens_est,
      output_tokens_est: smartDecision.output_tokens_est
    },
    registry,
    "smart"
  );

  return {
    chosen_provider: smartDecision.provider,
    chosen_tier: smartDecision.tier,
    reason: smartDecision.classifier?.reason ?? smartDecision.gateReason ?? smartDecision.source,
    complexity: smartDecision.complexity,
    risk: smartDecision.risk,
    task_type: smartDecision.task_type,
    legacy_provider: legacyProvider,
    legacy_tier: legacyEntry?.tier ?? null,
    estimated_savings_usd: round(legacyCost - smartCost),
    confidence: smartDecision.router_confidence,
    shadow_mode: options.shadowMode ?? true
  };
}
