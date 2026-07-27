import { routeRequest } from "./smartRoute/route.js";
import { logRoutingDecision } from "./smartRoute/decisionLog.js";

/**
 * Shadow-mode adaptive routing (PARAGON directive §20 stage 3).
 *
 * Computes what src/smartRoute/route.js would have selected for this
 * request and records it alongside the legacy decision that actually
 * served the request, purely for later comparison via
 * smartRouteReport.js / shadowReport.js.
 *
 * This function NEVER affects what serves the request: it is invoked
 * fire-and-forget after the legacy path has already been chosen, and any
 * error inside it is swallowed (logged, not thrown) so a bug in the
 * adaptive engine can never take down a live request. This intentionally
 * stays true regardless of routing.smartRoute.mode — PARAGON does not yet
 * serve requests through smartRoute (that is a later, explicitly-approved
 * rollout stage); today every mode other than "legacy" only observes.
 */
export function recordShadowRoutingDecision({ body, headers, config, legacyTask, legacyProvider }) {
  const mode = config?.routing?.smartRoute?.mode;
  if (mode === "legacy") {
    return Promise.resolve(null);
  }

  return routeRequest(body, headers, config)
    .then((decision) =>
      logRoutingDecision({
        legacy_provider: legacyProvider,
        legacy_task: legacyTask,
        smart_provider: decision.provider,
        smart_model: decision.model,
        smart_source: decision.source,
        smart_gate_reason: decision.gateReason,
        shadow_match: decision.provider != null ? decision.provider === legacyProvider : null,
        task_type: decision.task_type ?? legacyTask,
        complexity: decision.complexity,
        risk: decision.risk,
        router_confidence: decision.router_confidence,
        cost_estimate: decision.cost_estimate,
        mode
      })
    )
    .catch((error) => {
      console.warn("SmartRoute shadow evaluation failed (legacy path unaffected):", error.message);
    });
}
