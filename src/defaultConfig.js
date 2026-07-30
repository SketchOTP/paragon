import { DEFAULT_ORCHESTRATION_CONFIG } from "./orchestration/governorPolicy.js";

export const BUILTIN_PROVIDERS = ["claude", "codex", "cursor", "antigravity"];

/** Legacy exposed-model id accepted as an alias for "paragon" (pre-rename). */
export const LEGACY_EXPOSED_MODEL_ALIAS = "routerbot-local";

/** Bump when defaultConfig's shape changes in a way existing configs must migrate for. */
export const CONFIG_VERSION = 2;

/**
 * PARAGON-D-004D1 deprecation notice for the fields below.
 *
 * `providers.*.model`, `routing.defaultProvider` and `routing.fallbackChain`
 * are DEPRECATED for automatic routing. They are retained for backward
 * compatibility, are not authoritative for normal live routing, are hidden
 * from the primary dashboard, and are scheduled for possible schema removal
 * after D-004D activation plus an explicit config migration. The
 * machine-readable version of this notice — including what supersedes each
 * field — lives in src/deprecatedConfig.js and is what the dashboard renders.
 */
export const defaultConfig = {
  configVersion: CONFIG_VERSION,
  server: {
    host: "127.0.0.1",
    port: 4117,
    exposedModel: "paragon",
    apiKey: "",
    tailscaleHost: "",
    tailscaleServePort: 9420,
    tailscaleFunnelPort: 10000,
    cursorBaseUrl: ""
  },
  providers: {
    claude: {
      type: "builtin",
      label: "Claude Code",
      icon: "🧠",
      // Bundled avatar shown on the provider card. Operator-replaceable via
      // the card's avatar control (see src/providerAvatars.js).
      avatar: "/avatars/claude.webp",
      enabled: true,
      command: "claude",
      // DEPRECATED for automatic routing (PARAGON-D-004D1) — see the notice
      // above defaultConfig. Kept so existing configs round-trip unchanged.
      model: "",
      models: [],
      timeoutMs: 300000
    },
    codex: {
      type: "builtin",
      label: "Codex",
      icon: "⚡",
      avatar: "/avatars/codex.webp",
      enabled: true,
      command: "codex",
      model: "",
      models: [],
      timeoutMs: 300000
    },
    cursor: {
      type: "builtin",
      label: "Cursor Agent",
      icon: "🖱️",
      avatar: "/avatars/cursor.webp",
      enabled: true,
      command: "cursor-agent",
      model: "sonnet-4",
      models: [],
      timeoutMs: 300000
    },
    // Disabled by default — running this provider requires
    // --dangerously-skip-permissions (see src/cli.js providerSpecs), which
    // auto-approves all tool/command execution the agent attempts. Enable
    // explicitly per-deployment only after accepting that risk.
    antigravity: {
      type: "builtin",
      label: "Antigravity CLI",
      icon: "🪐",
      avatar: "/avatars/antigravity.webp",
      enabled: false,
      command: "agy",
      model: "",
      models: [],
      stdinMode: "none",
      timeoutMs: 300000
    }
  },
  routing: {
    // DEPRECATED (PARAGON-D-004D1) — retained for backward compatibility,
    // not authoritative for live routing, hidden from the primary dashboard.
    // The static-default fallback was removed in D-004C1; an empty eligible
    // set is a bounded 503 no_eligible_model.
    defaultProvider: "codex",
    // DEPRECATED (PARAGON-D-004D1) — retained for backward compatibility.
    // Live fallback order is the per-request ranked attempt plan, not this list.
    fallbackChain: ["codex", "cursor"],
    // ACTIVE, but a preference and not a route: a matching provider receives
    // WEIGHTS.taskRoutePreference additional points in the live D-004C1
    // scorer. Eligibility, health, circuit, context, cost and capability
    // gates remain authoritative. See src/deprecatedConfig.js.
    taskRoutes: {
      code: "codex",
      debug: "codex",
      review: "codex",
      plan: "claude",
      explain: "cursor",
      docs: "claude",
      quick: "cursor"
    }
  },
  orchestration: DEFAULT_ORCHESTRATION_CONFIG,
  // PARAGON-D-004C: automatic provider model-catalog refresh/validation.
  // See src/modelCatalogScheduler.js + src/modelCatalogRefresh.js.
  modelCatalog: {
    enabled: true,
    refreshIntervalHours: 24,
    refreshOnStartupIfStale: true,
    validationTtlHours: 24,
    maxConcurrentProviderRefreshes: 1,
    maxValidationProbesPerProvider: 10,
    retryBackoffMinutes: 60
  },
  // PARAGON-D-004D: capability-aware, reasoning-cost-aware,
  // outcome-calibrated routing. `mode: "shadow"` computes the new ranking
  // alongside the live PARAGON-D-004C1 decision without ever changing
  // provider/model selection, fallback order, or the response. Live
  // activation is gated behind a separate directive — these defaults
  // preserve current live behavior exactly.
  routingIntelligence: {
    enabled: true,
    mode: "shadow",
    unknownLargeContextThresholdTokens: 50000,
    telemetryRetentionDays: 30,
    minimumSamplesForMeasuredEstimate: 10,
    maximumAttempts: 4,
    // 0..1 — how scarce the subscription allowance currently is. Scales the
    // quota-scarcity penalty; 0 means "not scarce", not "free".
    quotaScarcity: 0,
    /** Reviewed alias records (see benchmarkCanonical.js normalizeAliasRecord). */
    canonicalAliasMappings: [],
    /** Operator-reviewed execution-profile overrides, keyed "provider/providerModelId". */
    reasoningProfileMappings: {},
    /** Operator-reviewed capability overrides, keyed "provider/providerModelId". */
    capabilityMappings: {},
    /** Operator-reviewed context overrides, keyed "provider/providerModelId". */
    contextOverrides: {},
    /** Bounded ring buffer of shadow decisions retained for comparison. */
    shadowRecordLimit: 200
  },
  integrations: {
    // Optional — enables real external benchmark citations (Artificial
    // Analysis / Design Arena, via OpenRouter's benchmarks API) in the
    // Model Routing panel. Without it, task-fit ranking stays
    // internal-only (see src/routing/router.js scoringMethodology()).
    openrouterApiKey: ""
  }
};
