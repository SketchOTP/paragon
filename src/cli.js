import { spawn } from "node:child_process";
import { authFlowFor } from "./authFlows.js";
import { clearAuthSession, getAuthSession, ingestAuthOutput } from "./authSessions.js";
import { discoverClaudeModels } from "./claudeModels.js";
import { discoverCodexModels } from "./codexModels.js";
import { alignProviderModel } from "./modelList.js";
import { checkHttpStatus, listHttpModels, runHttpProvider } from "./httpProvider.js";
import { addLog } from "./logStore.js";

export { getAuthSession };

// Auto-approved tool/command execution is enabled across every builtin
// provider (operator directive: "allowed for any model ... normal with
// the coding work we are doing"). Verified against each CLI's real
// --help output before changing flags, not assumed:
//  - claude: --tools "" was fully disabling every tool (not just
//    auto-approving them) — changed to --tools default. --permission-mode
//    dontAsk already auto-approves.
//  - codex: --ask-for-approval never was already auto-approving, but
//    --sandbox read-only blocked every write regardless of approval —
//    changed to workspace-write (scoped to the working directory, not
//    --dangerously-bypass-approvals-and-sandbox's unsandboxed full access).
//  - cursor: --mode ask is documented as "read-only" Q&A — cursor could
//    never write or edit a file through PARAGON as previously configured,
//    independent of any permission setting. Removed --mode ask, added
//    --force (alias --yolo) to auto-approve tool calls in the CLI's
//    normal execution mode.
const providerSpecs = {
  claude: {
    authArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    modelsArgs: null,
    runArgs: ({ model }) => [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "default",
      ...modelArg("--model", model)
    ]
  },
  codex: {
    authArgs: ["login", "--device-auth"],
    statusArgs: ["login", "status"],
    modelsArgs: null,
    runArgs: ({ model }) => [
      "--ask-for-approval",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      ...modelArg("--model", model),
      "-"
    ]
  },
  cursor: {
    authArgs: ["login"],
    statusArgs: ["status"],
    modelsArgs: ["models"],
    runArgs: ({ model }) => [
      "--print",
      "--trust",
      "--force",
      ...modelArg("--model", model)
    ]
  },
  // Real CLI contract verified by hand against the installed `agy` binary
  // (--help, and live --print tests) — not inferred from docs. Two things
  // that differ from every other builtin provider here:
  //  1. The prompt must be a direct argument to --print, not piped via
  //     stdin (confirmed: piping via stdin produced a canned, unrelated
  //     response every time; passing it as an arg answered correctly).
  //  2. Even a trivial prompt attempts a tool/command call, which headless
  //     mode silently denies (zero output) unless permissions are skipped.
  //     --dangerously-skip-permissions is required for this provider to
  //     produce any output at all — same auto-approve policy as the other
  //     providers above, just via this CLI's own flag name.
  antigravity: {
    authArgs: [],
    statusArgs: ["models"],
    modelsArgs: ["models"],
    runArgs: ({ model, prompt }) => [
      "--print",
      prompt ?? "",
      "--dangerously-skip-permissions",
      "--sandbox",
      "--output-format",
      "text",
      ...modelArg("--model", model)
    ]
  }
};

function providerType(provider, providerConfig) {
  if (providerConfig?.type === "http") {
    return "http";
  }
  if (providerConfig?.type === "generic-cli") {
    return "generic-cli";
  }
  if (providerSpecs[provider]) {
    return "builtin";
  }
  throw new Error(`Unknown provider: ${provider}`);
}

function buildGenericSpec(providerConfig) {
  return {
    authArgs: providerConfig.authArgs ?? [],
    statusArgs: providerConfig.statusArgs ?? null,
    modelsArgs: providerConfig.modelsArgs ?? null,
    runArgs: ({ model }) => expandArgs(providerConfig.runArgs ?? ["-"], model)
  };
}

export function expandArgs(args, model) {
  return args.map((arg) => String(arg).replaceAll("{{model}}", model ?? ""));
}

function envForProvider(provider) {
  const env = { ...process.env, NO_COLOR: "1" };
  // antigravity is Gemini-family (agy models lists gemini-3.x variants) and
  // shares the same conflicting env-var surface gemini-cli used to.
  if (provider !== "antigravity") {
    return env;
  }
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_GENAI_USE_VERTEXAI;
  delete env.GOOGLE_GENAI_USE_GCA;
  env.GEMINI_DEFAULT_AUTH_TYPE = "oauth-personal";
  return env;
}

/** Let CLIs open a browser on the host when a display exists; dashboard also opens the login URL on your PC. */
function authEnvForProvider(provider) {
  const env = envForProvider(provider);
  delete env.NO_BROWSER;
  delete env.NO_OPEN_BROWSER;
  return env;
}

function modelArg(flag, model) {
  return model ? [flag, model] : [];
}

export function getProviderSpec(provider, providerConfig) {
  const type = providerType(provider, providerConfig);
  if (type === "http") {
    return null;
  }
  if (type === "generic-cli") {
    return buildGenericSpec(providerConfig);
  }
  const spec = providerSpecs[provider];
  if (!spec) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return spec;
}

export async function runStatus(provider, providerConfig, { quiet = false } = {}) {
  const type = providerType(provider, providerConfig);

  if (type === "http") {
    return checkHttpStatus(provider, providerConfig, { quiet });
  }

  const spec = getProviderSpec(provider, providerConfig);
  if (!spec.statusArgs?.length) {
    return { stdout: "No status command configured", stderr: "", code: 0 };
  }

  return runProcess({
    provider,
    command: providerConfig.command,
    args: spec.statusArgs,
    timeoutMs: 30000,
    logType: "status",
    quiet
  });
}

export async function listModels(provider, providerConfig) {
  const type = providerType(provider, providerConfig);

  if (type === "http") {
    return listHttpModels(provider, providerConfig);
  }

  let models = [];

  if (provider === "claude") {
    models = await discoverClaudeModels(providerConfig.command);
    if (!models.length) {
      throw new Error("Claude model catalog unavailable — upgrade the claude CLI");
    }
  } else if (provider === "codex") {
    models = await discoverCodexModels(providerConfig.command);
    if (!models.length) {
      throw new Error(
        "Codex CLI model catalog unavailable — upgrade codex or reinstall the codex snap"
      );
    }
  } else {
    const spec = getProviderSpec(provider, providerConfig);
    if (!spec.modelsArgs?.length) {
      addLog({
        type: "models",
        provider,
        level: "info",
        message: "Provider CLI has no model-list command — leave model empty to use CLI default"
      });
      return [];
    }

    const result = await runProcess({
      provider,
      command: providerConfig.command,
      args: spec.modelsArgs,
      timeoutMs: 60000,
      logType: "models",
      quiet: true
    });
    models = parseModels(provider, result.stdout);
    if (provider === "cursor") {
      models = sortCursorModels(models);
    }
    if (!models.length) {
      throw new Error("Model list command returned no models");
    }
  }

  const aligned = alignProviderModel(providerConfig, models);
  addLog({
    type: "models",
    provider,
    level: "info",
    message: `Loaded ${aligned.length} models from provider`
  });
  return aligned;
}

const authProcesses = new Map();

function trackAuthProcess(provider, child) {
  authProcesses.set(provider, { pid: child.pid, startedAt: Date.now(), child });
  const finish = (code, signal) => {
    authProcesses.delete(provider);
    addLog({
      type: code === 0 ? "auth-complete" : "auth",
      provider,
      level: code === 0 ? "info" : "warn",
      message:
        code === 0
          ? "Sign-in completed successfully."
          : `Auth process exited with code ${code ?? "null"} signal ${signal ?? "none"}`
    });
  };
  child.on("exit", finish);
  child.on("error", () => authProcesses.delete(provider));
}

function isReadyFromStatus(provider, result) {
  const out = (result.stdout || result.stderr || "").trim();
  if (provider === "claude") {
    try {
      return JSON.parse(out).loggedIn === true;
    } catch {
      return /logged.?in/i.test(out);
    }
  }
  return /logged in|signed in|✓/i.test(out);
}

async function checkProviderReady(provider, providerConfig) {
  const result = await runStatus(provider, providerConfig);
  return {
    ok: isReadyFromStatus(provider, result),
    output: (result.stdout || result.stderr || "").trim()
  };
}

export function getAuthState(provider) {
  return {
    provider,
    flow: authFlowFor(provider),
    session: getAuthSession(provider),
    inProgress: authProcesses.has(provider)
  };
}

export async function startAuth(provider, providerConfig, { force = false } = {}) {
  const type = providerType(provider, providerConfig);

  if (type === "http") {
    throw new Error("HTTP providers do not use CLI auth — configure baseUrl and apiKey instead");
  }

  if (!force) {
    try {
      const ready = await checkProviderReady(provider, providerConfig);
      if (ready.ok) {
        return {
          alreadyAuthenticated: true,
          output: ready.output,
          mode: authFlowFor(provider).mode
        };
      }
    } catch {
      // Not ready — proceed with sign-in flow.
    }
  }

  return startCliAuth(provider, providerConfig);
}

function startCliAuth(provider, providerConfig) {
  const spec = getProviderSpec(provider, providerConfig);
  if (!spec.authArgs?.length) {
    throw new Error("No auth command configured for this provider");
  }

  clearAuthSession(provider);

  const child = spawn(providerConfig.command, spec.authArgs, {
    cwd: process.cwd(),
    env: authEnvForProvider(provider),
    // stdin must be writable, not "ignore" — some CLIs (claude's current
    // login flow, confirmed by hand: "Paste code here if prompted >") need
    // a manual authorization code written back after the browser step.
    stdio: ["pipe", "pipe", "pipe"]
  });

  addLog({
    type: "auth",
    provider,
    level: "info",
    message: `Started: ${providerConfig.command} ${spec.authArgs.join(" ")}`
  });

  let loginUrlLogged = false;
  let deviceCodeLogged = false;

  const handleAuthChunk = (chunk, level) => {
    const text = chunk.toString();
    addLog({ type: "auth", provider, level, message: text });
    const session = ingestAuthOutput(provider, text);
    if (session?.url && !loginUrlLogged) {
      loginUrlLogged = true;
      addLog({
        type: "auth",
        provider,
        level: "info",
        message: `Open login in your browser: ${session.url}`
      });
    }
    if (session?.deviceCode && !deviceCodeLogged) {
      deviceCodeLogged = true;
      addLog({
        type: "auth",
        provider,
        level: "info",
        message: `Device code: ${session.deviceCode}`
      });
    }
  };

  child.stdout.on("data", (chunk) => handleAuthChunk(chunk, "info"));
  child.stderr.on("data", (chunk) => handleAuthChunk(chunk, "warn"));
  child.on("error", (error) => {
    addLog({ type: "auth", provider, level: "error", message: error.message });
  });

  trackAuthProcess(provider, child);

  return { pid: child.pid, mode: authFlowFor(provider).mode };
}

/**
 * Writes a manually-copied authorization code back to a provider's
 * in-progress login process. Generic across providers — anything spawned
 * via startCliAuth() is trackable here, not just one hardcoded provider.
 */
export function submitAuthCode(provider, code) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) {
    throw new Error("Authorization code is required");
  }
  const entry = authProcesses.get(provider);
  if (!entry?.child?.stdin?.writable) {
    throw new Error(`No ${provider} login in progress. Click Sign in first.`);
  }
  entry.child.stdin.write(`${trimmed}\n`);
  addLog({
    type: "auth",
    provider,
    level: "info",
    message: "Authorization code submitted — waiting for sign-in to finish."
  });
  return { ok: true };
}

export function parseModels(provider, stdout) {
  if (provider === "codex") {
    const body = JSON.parse(stdout);
    return (body.models ?? [])
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        id: model.slug,
        name: model.display_name || model.slug
      }));
  }

  if (provider === "cursor") {
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(" - "))
      .map((line) => {
        const [id, ...nameParts] = line.split(" - ");
        return {
          id: id.trim(),
          name: nameParts.join(" - ").replace(/\s+\((current|default)\)$/i, "").trim()
        };
      });
  }

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ id: line, name: line }));
}

function sortCursorModels(models) {
  const rank = (id) => {
    if (id.startsWith("composer")) {
      return 0;
    }
    if (id === "auto") {
      return 1;
    }
    return 2;
  };
  return [...models].sort((a, b) => {
    const byRank = rank(a.id) - rank(b.id);
    if (byRank !== 0) {
      return byRank;
    }
    return a.name.localeCompare(b.name);
  });
}

export async function runProvider(provider, providerConfig, prompt, onChunk, { onSpawn } = {}) {
  const type = providerType(provider, providerConfig);

  if (type === "http") {
    return runHttpProvider(provider, providerConfig, prompt, onChunk);
  }

  const spec = getProviderSpec(provider, providerConfig);
  const stdinMode = providerConfig.stdinMode ?? "prompt";
  return runProcess({
    provider,
    command: providerConfig.command,
    // `prompt` is passed through for providers whose runArgs embeds it as a
    // trailing CLI argument (e.g. antigravity's `--print <prompt>`) —
    // providers that take the prompt via stdin instead simply destructure
    // only `{ model }` and ignore it.
    args: spec.runArgs({ model: providerConfig.model, prompt }),
    stdinText: stdinMode === "none" ? undefined : prompt,
    timeoutMs: providerConfig.timeoutMs,
    logType: "completion",
    onChunk,
    onSpawn
  });
}

function runProcess({ provider, command, args, stdinText, timeoutMs, logType, onChunk, onSpawn, quiet = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: envForProvider(provider),
      stdio: ["pipe", "pipe", "pipe"]
    });
    onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`${provider} timed out after ${timeoutMs}ms`);
      if (!settled) {
        settled = true;
        reject(error);
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onChunk?.(text);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Must be attached before the write below: if the child has already
    // exited (or exits mid-write), writing to its stdin raises EPIPE on the
    // stream itself. Left unhandled, that's an uncaught 'error' event that
    // crashes the whole PARAGON process — this converts it into a normal
    // rejected execution instead. `exit`/`error` below still fire and are
    // the source of truth when they do; `settled` prevents a double-settle.
    child.stdin.on("error", (error) => {
      if (settled) return;
      if (error.code === "EPIPE") {
        settled = true;
        clearTimeout(timer);
        const wrapped = new Error(`${provider}: stdin closed before the prompt was fully written`);
        wrapped.code = "EPIPE";
        reject(wrapped);
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    if (stdinText) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const summary = `${command} exited ${code}; stdout ${stdout.length} chars; stderr ${stderr.length} chars`;
      const shouldLog = !quiet || logType !== "status" || code !== 0;
      if (shouldLog) {
        addLog({
          type: logType,
          provider,
          level: code === 0 ? "info" : "error",
          message: summary
        });
      }
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      } else {
        const error = new Error(stderr.trim() || `${command} exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
      }
    });
  });
}
