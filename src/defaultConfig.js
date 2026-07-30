import { DEFAULT_ORCHESTRATION_CONFIG } from "./orchestration/governorPolicy.js";

export const BUILTIN_PROVIDERS = ["claude", "codex", "cursor", "antigravity"];

/** Legacy exposed-model id accepted as an alias for "paragon" (pre-rename). */
export const LEGACY_EXPOSED_MODEL_ALIAS = "routerbot-local";

/** Bump when defaultConfig's shape changes in a way existing configs must migrate for. */
export const CONFIG_VERSION = 3;

/**
 * Config schema, version 3 (PARAGON-D-004E).
 *
 * Removed in this version — see migrateRoutingSchema() in configMigrate.js,
 * which backs up and rewrites existing configs:
 *
 *   providers.*.model        the model is chosen per request from the ranked
 *                            eligible catalog; a stored preference could only
 *                            ever disagree with what actually runs
 *   routing.defaultProvider  no static fallback exists; an empty eligible set
 *                            is a bounded 503
 *   routing.fallbackChain    fallback order is the per-request attempt plan
 *   routing.taskRoutes       replaced by the single routing.priority control
 *
 * Nothing that carries credentials, endpoints, provider enablement, avatars,
 * or Tailscale settings is touched by that migration.
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
      models: [],
      stdinMode: "none",
      timeoutMs: 300000
    }
  },
  routing: {
    /**
     * The only routing preference in the product. One of balanced | quality |
     * cost | speed; resolves transparently to expected-utility weights (see
     * src/routing/routingPriority.js). It can reorder admissible candidates
     * but can never admit an inadmissible one — capability, context, health,
     * circuit, quota, cost-ceiling and catalog gates are decided first.
     */
    priority: "balanced"
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
  /**
   * Tuning for the single automatic routing engine — capability-aware,
   * reasoning-cost-aware, outcome-calibrated. These are engineering bounds,
   * not everyday product settings: the dashboard exposes them read-only in
   * Diagnostics and never as a normal control. There is deliberately no mode
   * switch here; PARAGON has one routing engine and it is always the one that
   * executes.
   */
  automaticRouting: {
    enabled: true,
    unknownLargeContextThresholdTokens: 50000,
    telemetryRetentionDays: 30,
    minimumSamplesForMeasuredEstimate: 10,
    maximumAttempts: 4,
    /** Reviewed alias records (see benchmarkCanonical.js normalizeAliasRecord). */
    canonicalAliasMappings: [],
    /** Operator-reviewed execution-profile overrides, keyed "provider/providerModelId". */
    reasoningProfileMappings: {},
    /** Operator-reviewed capability overrides, keyed "provider/providerModelId". */
    capabilityMappings: {},
    /** Operator-reviewed context overrides, keyed "provider/providerModelId". */
    contextOverrides: {}
  },
  integrations: {
    // Optional — enables real external benchmark citations (Artificial
    // Analysis / Design Arena, via OpenRouter's benchmarks API) in the
    // Model Routing panel. Without it, task-fit ranking stays
    // internal-only (see src/routing/expectedUtility.js).
    openrouterApiKey: ""
  }
};
