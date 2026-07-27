import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readAllDecisions } from "./decisionLog.js";
import { detectDangerDowngrade, enrichDecision, computeCanaryRates } from "./shadowReport.js";
import { canUseSnapshotForActiveMode, isActiveSmartRouteMode, readCurrentSnapshot } from "./modelSnapshotStore.js";
import { assertNotProductionWrite, getDataDir, PATHS } from "./dataPaths.js";

function getStatePath() {
  return PATHS.canaryState;
}

export const DEFAULT_CANARY_CONFIG = {
  enabled: true,
  percent: 10,
  allowedTaskTypes: ["rewrite", "summarize", "extract", "chat"],
  blockedTaskTypes: ["architecture", "code_debug", "research", "high_stakes"],
  maxComplexity: 3,
  maxRisk: 2,
  requireClassifierConfidence: 0.75,
  allowDowngrades: true,
  allowDangerDowngrades: false,
  fallbackToLegacyOnBlock: true,
  rollback: {
    enabled: true,
    minRequests: 25,
    maxValidationFailureRate: 0.1,
    maxTimeoutRate: 0.1,
    maxThumbsDownRate: 0.1,
    maxFallbackRate: 0.2
  }
};

const IMPLICIT_BLOCKED_CAPABILITIES = [
  { field: "needs_long_context", reason: "long_context_blocked" },
  { field: "needs_tools", reason: "tool_use_blocked" },
  { field: "needs_vision", reason: "vision_blocked" }
];

export function isCanaryMode(config) {
  return (config?.routing?.smartRoute?.mode ?? "shadow_test") === "canary";
}

export function mergeCanaryConfig(smartRoute = {}) {
  const incoming = smartRoute.canary ?? {};
  return {
    ...DEFAULT_CANARY_CONFIG,
    ...incoming,
    rollback: {
      ...DEFAULT_CANARY_CONFIG.rollback,
      ...(incoming.rollback ?? {})
    }
  };
}

export async function readCanaryState() {
  try {
    const raw = await fs.readFile(getStatePath(), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { rolled_back: false };
    }
    throw error;
  }
}

export async function writeCanaryState(state) {
  const statePath = getStatePath();
  assertNotProductionWrite(statePath);
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function triggerCanaryRollback(reason, rates) {
  const state = {
    rolled_back: true,
    reason,
    rates,
    at: new Date().toISOString()
  };
  await writeCanaryState(state);
  return state;
}

export async function clearCanaryRollback() {
  await writeCanaryState({ rolled_back: false });
}

export function inCanaryPercent(seed, percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  if (pct <= 0) {
    return false;
  }
  if (pct >= 100) {
    return true;
  }
  const hash = crypto.createHash("sha256").update(String(seed)).digest();
  const bucket = hash.readUInt32BE(0) % 100;
  return bucket < pct;
}

export function evaluateCanaryEligibility(smartDecision, legacyProvider, config, registry = []) {
  const smartRoute = config?.routing?.smartRoute ?? {};
  const canary = mergeCanaryConfig(smartRoute);
  const blockReasons = [];

  if (!canary.enabled) {
    blockReasons.push("canary_disabled");
  }

  const taskType = smartDecision?.task_type ?? "unknown";
  if (canary.allowedTaskTypes?.length && !canary.allowedTaskTypes.includes(taskType)) {
    blockReasons.push("task_type_not_allowed");
  }
  if (canary.blockedTaskTypes?.includes(taskType)) {
    blockReasons.push("task_type_blocked");
  }

  const complexity = smartDecision?.complexity ?? 0;
  if (complexity > (canary.maxComplexity ?? 3)) {
    blockReasons.push("complexity_too_high");
  }

  const risk = smartDecision?.risk ?? 0;
  if (risk > (canary.maxRisk ?? 2)) {
    blockReasons.push("risk_too_high");
  }

  const confidence = smartDecision?.router_confidence;
  const minConfidence = canary.requireClassifierConfidence ?? 0.75;
  if (typeof confidence === "number" && confidence < minConfidence) {
    blockReasons.push("low_confidence");
  } else if (confidence == null && minConfidence > 0) {
    blockReasons.push("missing_confidence");
  }

  const classifier = smartDecision?.classifier ?? {};
  for (const rule of IMPLICIT_BLOCKED_CAPABILITIES) {
    if (classifier[rule.field]) {
      blockReasons.push(rule.reason);
    }
  }

  if (smartDecision?.features?.requires_tools) {
    blockReasons.push("tool_use_blocked");
  }
  if (smartDecision?.features?.requires_strict_json) {
    blockReasons.push("strict_json_blocked");
  }
  if (smartDecision?.features?.has_image) {
    blockReasons.push("vision_blocked");
  }

  const enriched = enrichDecision(
    {
      legacy_provider: legacyProvider,
      smart_provider: smartDecision?.provider,
      legacy_tier: smartDecision?.legacy_tier,
      smart_tier: smartDecision?.tier,
      complexity,
      risk,
      task_type: taskType
    },
    registry
  );
  const danger = detectDangerDowngrade(enriched);
  if (danger.danger) {
    if (!canary.allowDangerDowngrades) {
      blockReasons.push("danger_downgrade_blocked");
    } else if (!canary.allowDowngrades) {
      blockReasons.push("downgrade_blocked");
    }
  } else if (!canary.allowDowngrades && isTierDowngrade(enriched)) {
    blockReasons.push("downgrade_blocked");
  }

  const eligible = blockReasons.length === 0;

  return {
    eligible,
    blockReasons: [...new Set(blockReasons)],
    canary
  };
}

function isTierDowngrade(row) {
  if (!row.legacy_tier || !row.smart_tier) {
    return false;
  }
  const ranks = { local: 0, cheap: 1, mid: 2, premium: 3 };
  return (ranks[row.smart_tier] ?? 0) < (ranks[row.legacy_tier] ?? 0);
}

export async function checkCanaryRollback(config, decisions = null) {
  const smartRoute = config?.routing?.smartRoute ?? {};
  const canary = mergeCanaryConfig(smartRoute);
  const rollback = canary.rollback ?? DEFAULT_CANARY_CONFIG.rollback;
  const state = await readCanaryState();

  if (state.rolled_back) {
    return {
      triggered: true,
      active: true,
      reason: state.reason ?? "previously_rolled_back",
      rates: state.rates ?? null,
      at: state.at ?? null
    };
  }

  if (!rollback.enabled || !isCanaryMode(config)) {
    return { triggered: false, active: false, reason: null, rates: null, at: null };
  }

  const rows = (decisions ?? (await readAllDecisions())).filter((row) => row.canary_executed);
  if (rows.length < (rollback.minRequests ?? 25)) {
    return {
      triggered: false,
      active: false,
      reason: null,
      rates: computeCanaryRates(rows),
      at: null,
      min_requests_pending: true
    };
  }

  const rates = computeCanaryRates(rows);
  const failures = [];

  if (rates.validation_failure_rate > (rollback.maxValidationFailureRate ?? 0.1)) {
    failures.push("validation_failure_rate");
  }
  if (rates.timeout_rate > (rollback.maxTimeoutRate ?? 0.1)) {
    failures.push("timeout_rate");
  }
  if (rates.thumbs_down_rate > (rollback.maxThumbsDownRate ?? 0.1)) {
    failures.push("thumbs_down_rate");
  }
  if (rates.fallback_rate > (rollback.maxFallbackRate ?? 0.2)) {
    failures.push("fallback_rate");
  }

  if (!failures.length) {
    return { triggered: false, active: false, reason: null, rates, at: null };
  }

  const reason = failures.join(",");
  await triggerCanaryRollback(reason, rates);
  return { triggered: true, active: true, reason, rates, at: new Date().toISOString()   };
}

export function canaryStatePath() {
  return statePath;
}

export async function resolveRoutingProvider({
  smartDecision,
  legacyProvider,
  config,
  registry = [],
  seed = ""
}) {
  const mode = config?.routing?.smartRoute?.mode ?? "shadow_test";

  if (mode === "manual" || mode === "shadow_test") {
    return buildResult(legacyProvider, {
      mode,
      eligible: false,
      executed: false,
      blocked: false,
      blockReasons: ["shadow_or_manual_mode"]
    });
  }

  if (mode !== "canary") {
    const provider = await resolveFullActiveProvider(smartDecision, legacyProvider, config);
    const snapshot = await readCurrentSnapshot();
    const gate = canUseSnapshotForActiveMode(config, snapshot);
    const blockReasons =
      provider === legacyProvider && !gate.allowed
        ? ["model_intelligence_stale"]
        : provider === legacyProvider && smartDecision?.gateReason?.includes("no_model_passed_quality_floor")
          ? ["no_model_passed_quality_floor"]
          : provider === legacyProvider
            ? ["active_mode_fallback"]
            : [];
    return buildResult(provider, {
      mode,
      eligible: true,
      executed: provider !== legacyProvider,
      blocked: provider === legacyProvider,
      blockReasons
    });
  }

  const rollback = await checkCanaryRollback(config);
  if (rollback.active) {
    return buildResult(legacyProvider, {
      mode,
      eligible: false,
      executed: false,
      blocked: true,
      blockReasons: ["canary_rolled_back"],
      rollback
    });
  }

  const eligibility = evaluateCanaryEligibility(smartDecision, legacyProvider, config, registry);
  if (!eligibility.eligible) {
    return buildResult(legacyProvider, {
      mode,
      eligible: false,
      executed: false,
      blocked: true,
      blockReasons: eligibility.blockReasons,
      rollback
    });
  }

  const canary = eligibility.canary;
  const inBucket = inCanaryPercent(seed || `${legacyProvider}:${smartDecision?.task_type}`, canary.percent);
  if (!inBucket) {
    return buildResult(legacyProvider, {
      mode,
      eligible: true,
      executed: false,
      blocked: true,
      blockReasons: ["canary_percent_excluded"],
      rollback
    });
  }

  const provider = await resolveFullActiveProvider(smartDecision, legacyProvider, config);
  if (provider === legacyProvider) {
    const snapshot = await readCurrentSnapshot();
    const gate = canUseSnapshotForActiveMode(config, snapshot);
    const blockReasons = !gate.allowed
      ? ["model_intelligence_stale"]
      : ["smart_provider_unavailable"];
    return buildResult(legacyProvider, {
      mode,
      eligible: true,
      executed: false,
      blocked: true,
      blockReasons,
      rollback
    });
  }

  return buildResult(provider, {
    mode,
    eligible: true,
    executed: true,
    blocked: false,
    blockReasons: [],
    rollback
  });
}

async function resolveFullActiveProvider(smartDecision, legacyProvider, config) {
  const mode = config?.routing?.smartRoute?.mode ?? "shadow_test";
  if (isActiveSmartRouteMode(mode)) {
    const snapshot = await readCurrentSnapshot();
    const gate = canUseSnapshotForActiveMode(config, snapshot);
    if (!gate.allowed) {
      return legacyProvider;
    }
  }

  if (smartDecision?.provider) {
    const providerConfig = config?.providers?.[smartDecision.provider];
    if (providerConfig?.enabled) {
      return smartDecision.provider;
    }
  }
  return legacyProvider;
}

function buildResult(provider, canary) {
  return {
    provider,
    canary: {
      mode: canary.mode,
      eligible: canary.eligible,
      executed: canary.executed,
      blocked: canary.blocked,
      block_reasons: canary.blockReasons,
      rollback: canary.rollback ?? null
    }
  };
}