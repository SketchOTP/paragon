/**
 * Task-mode constrained optimization.
 * For low-risk cost-sensitive tasks, quality is a floor — not a reward.
 */

export const CHEAP_TASK_TYPES = ["chat", "rewrite", "summarize", "extract", "extract_json"];

export const PREMIUM_PROVIDERS = new Set(["codex"]);

export const DEFAULT_OPTIMIZATION = {
  balanced: {
    cheapTasks: {
      strategy: "min_cost_above_floor",
      taskTypes: ["chat", "rewrite", "summarize", "extract_json", "extract"],
      maxComplexity: 2,
      maxRisk: 2,
      minPricingConfidence: 0.7,
      qualityMarginPreference: 0.1,
      premiumAllowedOnlyIfNoCheaperPasses: true
    }
  },
  cost_saver: {
    cheapTasks: {
      strategy: "min_cost_above_floor",
      taskTypes: ["chat", "rewrite", "summarize", "extract_json", "extract"],
      maxComplexity: 3,
      maxRisk: 2,
      minPricingConfidence: 0.65,
      allowLowerQualityFloorDelta: 0.05,
      premiumAllowedOnlyIfNoCheaperPasses: true
    }
  },
  maximum_quality: {
    cheapTasks: {
      strategy: "max_quality_with_cost_awareness",
      taskTypes: ["chat", "rewrite", "summarize", "extract_json", "extract"],
      maxComplexity: 99,
      maxRisk: 99,
      minPricingConfidence: 0.5,
      premiumAllowedOnlyIfNoCheaperPasses: false
    }
  },
  canary: {
    cheapTasks: {
      strategy: "min_cost_above_floor",
      taskTypes: ["chat", "rewrite", "summarize", "extract_json", "extract"],
      maxComplexity: 2,
      maxRisk: 2,
      minPricingConfidence: 0.7,
      premiumAllowedOnlyIfNoCheaperPasses: true
    }
  },
  shadow_test: {
    cheapTasks: {
      strategy: "min_cost_above_floor",
      taskTypes: ["chat", "rewrite", "summarize", "extract_json", "extract"],
      maxComplexity: 2,
      maxRisk: 2,
      minPricingConfidence: 0.7,
      premiumAllowedOnlyIfNoCheaperPasses: true
    }
  }
};

export function mergeOptimizationConfig(smartRoute = {}) {
  const user = smartRoute.optimization ?? {};
  const out = {};
  for (const mode of Object.keys(DEFAULT_OPTIMIZATION)) {
    out[mode] = {
      cheapTasks: {
        ...DEFAULT_OPTIMIZATION[mode].cheapTasks,
        ...(user[mode]?.cheapTasks ?? {})
      }
    };
  }
  for (const [mode, cfg] of Object.entries(user)) {
    if (!out[mode]) {
      out[mode] = {
        cheapTasks: {
          ...DEFAULT_OPTIMIZATION.balanced.cheapTasks,
          ...(cfg.cheapTasks ?? {})
        }
      };
    }
  }
  return out;
}

export function getCheapTaskOptimization(smartRoute = {}, mode = null) {
  const resolvedMode = mode ?? smartRoute.mode ?? "balanced";
  const all = mergeOptimizationConfig(smartRoute);
  return (
    all[resolvedMode]?.cheapTasks ??
    all.balanced.cheapTasks
  );
}

/**
 * Whether this request should use min-cost-above-floor (or mode strategy).
 */
export function isCostFloorTask(taskType, options = {}) {
  const cheap = options.cheapTaskConfig ?? DEFAULT_OPTIMIZATION.balanced.cheapTasks;
  const taskTypes = cheap.taskTypes ?? CHEAP_TASK_TYPES;
  const key = taskType === "extract" ? "extract" : taskType;
  if (!taskTypes.includes(key) && !taskTypes.includes(taskType)) {
    return false;
  }

  const complexity = options.complexity ?? 1;
  const risk = options.risk ?? 1;
  if (complexity > (cheap.maxComplexity ?? 2)) return false;
  if (risk > (cheap.maxRisk ?? 2)) return false;
  if (options.requiresTools) return false;
  if (options.requiresVision) return false;
  if (options.longContext) return false;
  if (options.highStakes) return false;
  if (taskType === "high_stakes") return false;

  return true;
}

export function isPremiumModel(model) {
  if (!model) return false;
  if (PREMIUM_PROVIDERS.has(model.provider)) return true;
  const tier = model.tier ?? inferTierFromPricing(model);
  return tier === "premium";
}

function inferTierFromPricing(model) {
  if (model.local) return "local";
  const input = model.pricing?.input_per_1m;
  if (input == null) return "mid";
  if (input <= 0.5) return "cheap";
  if (input <= 2) return "mid";
  return "premium";
}

export function pricingConfidence(model) {
  if (model?.pricing?.pricing_confidence != null) return model.pricing.pricing_confidence;
  if (model?.pricing?.confidence != null) return model.pricing.confidence;
  // Legacy fixtures / known pricing without explicit confidence
  if (model?.pricing?.pricing_status === "valid") return 1;
  if (model?.pricing?.cost_sensitive_eligible === true) return 0.85;
  if (model?.pricing?.pricing_source && model.pricing.pricing_source !== "unknown") {
    return 0.85;
  }
  return 0;
}
