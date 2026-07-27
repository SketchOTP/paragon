import { TASK_PATTERN_SOURCES } from "./taskClassifier.js";

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
    cursorBaseUrl: "",
    tunnels: {
      ngrokAuthtoken: "",
      ngrokDomain: "",
      autostartCloudflared: false,
      autostartNgrok: false
    }
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
    antigravity: {
      type: "builtin",
      label: "Antigravity CLI",
      icon: "🚀",
      enabled: true,
      command: "agy",
      model: "gemini-3.5-flash",
      models: [],
      timeoutMs: 300000
    }
  },
  routing: {
    defaultProvider: "codex",
    fallbackChain: ["codex", "cursor", "antigravity"],
    namedRoutes: {
      cheap: "cursor",
      review: "codex",
      research: "claude",
      fallback: "antigravity"
    },
    taskRoutes: {
      code: "codex",
      debug: "codex",
      review: "codex",
      plan: "claude",
      explain: "antigravity",
      docs: "antigravity",
      quick: "cursor",
      ask: "cursor",
      agent: "cursor",
      multitask: "codex",
      ghost: "claude"
    },
    taskPatterns: { ...TASK_PATTERN_SOURCES },
    /**
     * Adaptive orchestration layer (PARAGON directive PARAGON-D-001), backed
     * by src/smartRoute/route.js. Schema mirrors what route.js/canary.js/
     * budget.js actually read (see config.example.json for the fully
     * annotated version) rather than inventing a parallel one.
     *
     * mode: "shadow_test" (default — compute and log the adaptive decision,
     * legacy taskRoutes still serves every request) | "balanced_live"
     * (canary-gated live serving) | "legacy" | "manual". Shadow-first
     * rollout (directive §20): defaults to shadow so adaptive selection is
     * observed before it is ever allowed to serve a live request.
     */
    smartRoute: {
      mode: "shadow_test",
      classifierProvider: "",
      largeContextThreshold: 100000,
      localPrivateFirst: false,
      escalationEnabled: false,
      confidenceThreshold: 0.55,
      defaultOutputTokensEst: 1200,
      explainDecisions: false,
      dailyBudgetUsd: null,
      premiumBudgetUsd: null,
      maxSingleRequestUsd: null,
      canary: {
        enabled: false,
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
      }
    }
  },
  /**
   * Session/context governor (directive §7) and subagent/worktree governor
   * (directive §8-9). RouterBot/PARAGON is a stateless per-request router,
   * not a long-lived agent session host, so these thresholds are config
   * only today — they exist so a future PARAGON job/session layer (or a
   * client that adopts these conventions) has one canonical place to read
   * them from, and so the dashboard has real settings to expose per the
   * directive rather than placeholders.
   */
  orchestration: {
    sessionGovernor: {
      contextWarningTokens: 80000,
      checkpointTokens: 100000,
      forcedRolloverTokens: 120000,
      absoluteContextCeilingTokens: 150000,
      checkpointIntervalMinutes: 60,
      normalSessionTargetMinutes: 90,
      forcedSessionRolloverMinutes: 120
    },
    subagentGovernor: {
      defaultSubagentCount: 0,
      maxParallelSubagents: 2,
      maxTotalSubagentsPerJob: 4,
      maxSubagentRuntimeMinutes: 45,
      recursiveSpawningEnabled: false,
      sharedUnrestrictedWritesAllowed: false
    }
  }
};
