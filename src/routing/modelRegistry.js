/**
 * Normalized model+capability registry (PARAGON-D-004).
 *
 * Built from real discovery (listModels()/runStatus() against the actual
 * installed CLIs and HTTP providers) plus a small, explicitly-labeled set
 * of heuristics for fields no CLI exposes directly (cost/latency class,
 * context window). Unknown stays unknown — nothing here is fabricated to
 * look more complete than it is.
 */

// Context windows are only filled in where there's a well-documented public
// spec for the model family. Everything else stays null (unknown) rather
// than guessed.
const KNOWN_CONTEXT_WINDOWS = [
  { pattern: /^claude-/, tokens: 200000 },
  { pattern: /^gpt-5/, tokens: 400000 },
  { pattern: /^gpt-oss/, tokens: 131072 }
];

function inferContextWindow(modelId) {
  const found = KNOWN_CONTEXT_WINDOWS.find((entry) => entry.pattern.test(modelId));
  return found ? found.tokens : null;
}

// Naming-pattern heuristic only — not a benchmark result. Used purely as a
// coarse, operator-overridable default; never presented as measured fact.
const ECONOMY_HINTS = /haiku|mini|flash|-low\b|small/i;
const PREMIUM_HINTS = /opus|mythos|fable|-pro\b|-high\b|-max\b|ultra/i;

function inferCostClass(modelId) {
  if (ECONOMY_HINTS.test(modelId)) return "economy";
  if (PREMIUM_HINTS.test(modelId)) return "premium";
  return "standard";
}

function inferLatencyClass(costClass) {
  // Coarse correlation only (bigger/premium models tend to run slower) —
  // not a measured latency figure. Real measured latency (from telemetry)
  // should always be preferred over this once available; see
  // attachPerformanceEvidence() in router.js.
  if (costClass === "economy") return "fast";
  if (costClass === "premium") return "slow";
  return "medium";
}

/**
 * Builds one registry entry per (provider, model). `statuses` is the same
 * shape /api/status already returns — reused rather than re-probed, so
 * building the registry never triggers extra CLI spawns.
 */
export function buildModelRegistry(config, statuses = {}) {
  const entries = [];
  const now = new Date().toISOString();

  for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
    if (!providerConfig.enabled) {
      continue;
    }
    const health = statuses[provider]?.ok === true ? "healthy" : statuses[provider] ? "unhealthy" : "unknown";
    const models = providerConfig.models?.length ? providerConfig.models : [{ id: providerConfig.model || "", name: providerConfig.model || "(default)" }];

    for (const model of models) {
      if (!model.id) {
        continue;
      }
      const costClass = inferCostClass(model.id);
      entries.push({
        provider,
        model: model.id,
        displayName: model.name || model.id,
        health,
        local: providerConfig.type === "http",
        contextWindow: inferContextWindow(model.id),
        capabilities: {
          // All current providers are coding-agent CLIs/HTTP completion
          // backends — these two are inherent to what they are, not
          // inferred from a benchmark.
          coding: true,
          tools: true,
          streaming: true,
          // No verified per-model reasoning benchmark exists for these
          // CLIs — left explicitly unknown rather than guessed.
          reasoning: "unknown"
        },
        costClass,
        latencyClass: inferLatencyClass(costClass),
        // Antigravity requires --dangerously-skip-permissions (auto-approves
        // all tool/command execution) — never eligible for automatic
        // routing regardless of score, only reachable via an explicit
        // forceProvider hint. See docs/evidence for the risk writeup.
        automaticEligibility: provider !== "antigravity",
        toolExecutionRisk: provider === "antigravity" ? "unrestricted" : "restricted",
        source: providerConfig.models?.length ? "discovered" : "configured",
        lastDiscoveryAt: now
      });
    }
  }

  return entries;
}
