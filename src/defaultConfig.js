import { TASK_PATTERN_SOURCES } from "./taskClassifier.js";

export const BUILTIN_PROVIDERS = ["claude", "codex", "cursor", "antigravity"];

export const defaultConfig = {
  server: {
    host: "127.0.0.1",
    port: 4117,
    exposedModel: "routerbot-local",
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
    taskPatterns: { ...TASK_PATTERN_SOURCES }
  }
};
