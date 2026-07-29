import { DEFAULT_ORCHESTRATION_CONFIG } from "./orchestration/governorPolicy.js";

export const BUILTIN_PROVIDERS = ["claude", "codex", "cursor", "antigravity"];

/** Legacy exposed-model id accepted as an alias for "paragon" (pre-rename). */
export const LEGACY_EXPOSED_MODEL_ALIAS = "routerbot-local";

/** Bump when defaultConfig's shape changes in a way existing configs must migrate for. */
export const CONFIG_VERSION = 2;

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
      enabled: true,
      command: "claude",
      model: "",
      models: [],
      timeoutMs: 300000
    },
    codex: {
      type: "builtin",
      label: "Codex",
      icon: "⚡",
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
      enabled: false,
      command: "agy",
      model: "",
      models: [],
      stdinMode: "none",
      timeoutMs: 300000
    }
  },
  routing: {
    defaultProvider: "codex",
    fallbackChain: ["codex", "cursor"],
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
  integrations: {
    // Optional — enables real external benchmark citations (Artificial
    // Analysis / Design Arena, via OpenRouter's benchmarks API) in the
    // Model Routing panel. Without it, task-fit ranking stays
    // internal-only (see src/routing/router.js scoringMethodology()).
    openrouterApiKey: ""
  }
};
