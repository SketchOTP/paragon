/**
 * Machine-readable configuration deprecation metadata (PARAGON-D-004D1,
 * Phase 7).
 *
 * These three fields are still present in every persisted config and are
 * still written back untouched on save. None of them is authoritative for
 * normal live routing:
 *
 *  - `providers.*.model` — PARAGON-D-004C1 removed the path that let dispatch
 *    substitute a configured model. Live attempts come from ranked,
 *    catalog-eligible registry entries only.
 *  - `routing.defaultProvider` — the static-default fallback was removed by
 *    PARAGON-D-004C1. An empty eligible set is now a bounded 503
 *    (`no_eligible_model`), not a downgrade to a configured provider.
 *  - `routing.fallbackChain` — live fallback order is the ranked attempt plan
 *    derived per request, not this stored list.
 *
 * They are deliberately NOT deleted here. Removing a field from the persisted
 * schema is a config migration with its own rollback story, and this directive
 * is a dashboard-truthfulness change. Deleting them would also make a
 * rollback to the previous release silently lose operator state. Schema
 * removal is a later, explicitly-authorized migration directive.
 *
 * The dashboard renders this list verbatim in its "Deprecated compatibility
 * fields" section, so the deprecation reason a reader sees is this text — not
 * a second copy of it that can drift.
 */

export const DEPRECATED_CONFIG_FIELDS = [
  {
    path: "providers.*.model",
    status: "deprecated",
    retainedForBackwardCompatibility: true,
    authoritativeForLiveRouting: false,
    hiddenFromPrimaryDashboard: true,
    supersededBy: "ranked catalog-eligible registry entries (per request)",
    since: "PARAGON-D-004C1",
    reason:
      "Not authoritative for normal live routing. Dispatch may not substitute a configured provider model; " +
      "the model is chosen per request from the ranked, catalog-eligible registry. Startup and post-refresh " +
      "reconciliation still clears this value when the catalog no longer considers it eligible.",
    scheduledRemoval: "possible schema removal after D-004D activation and an explicit config migration"
  },
  {
    path: "routing.defaultProvider",
    status: "deprecated",
    retainedForBackwardCompatibility: true,
    authoritativeForLiveRouting: false,
    hiddenFromPrimaryDashboard: true,
    supersededBy: "503 no_eligible_model when the eligible set is empty",
    since: "PARAGON-D-004C1",
    reason:
      "Not authoritative for normal live routing. The static-default fallback path was removed; availability is " +
      "no longer preserved by weakening an eligibility constraint, so an empty eligible set returns 503 " +
      "no_eligible_model instead of falling back to this provider.",
    scheduledRemoval: "possible schema removal after D-004D activation and an explicit config migration"
  },
  {
    path: "routing.fallbackChain",
    status: "deprecated",
    retainedForBackwardCompatibility: true,
    authoritativeForLiveRouting: false,
    hiddenFromPrimaryDashboard: true,
    supersededBy: "per-request ranked attempt plan",
    since: "PARAGON-D-004C1",
    reason:
      "Not authoritative for normal live routing. Fallback candidates and their order are derived per request " +
      "from the ranked eligible registry, subject to circuit, cost, context, capability and catalog gates — a " +
      "saved provider list is not the order a live request attempts.",
    scheduledRemoval: "possible schema removal after D-004D activation and an explicit config migration"
  }
];

/**
 * `routing.taskRoutes` is NOT in the list above: it is still read by the live
 * D-004C1 scorer. It is a bounded scoring preference (see
 * scoringMethodology().weights.taskRoutePreference), not a route, so it stays
 * editable — under wording that says exactly that.
 */
export const ACTIVE_BUT_MISREPRESENTED_FIELDS = [
  {
    path: "routing.taskRoutes",
    status: "active-preference",
    authoritativeForLiveRouting: false,
    effect: "additive score bonus applied to a matching provider in the live D-004C1 scorer",
    notARoute: true,
    reason:
      "Still read by the live scorer, but only as a preference. Eligibility, health, circuit state, context fit, " +
      "cost ceiling and capability gates remain authoritative and can and do override it.",
    appliesTo: "PARAGON-D-004C1 live scorer only — not the D-004D shadow expected-utility scorer"
  }
];
