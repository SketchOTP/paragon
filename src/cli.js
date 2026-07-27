import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { authFlowFor } from "./authFlows.js";
import { clearAuthSession, getAuthSession, ingestAuthOutput } from "./authSessions.js";
import { discoverClaudeModels } from "./claudeModels.js";
import { discoverCodexModels } from "./codexModels.js";
import {
  buildAntigravityPrintCommand,
  checkAntigravityAuthStatus,
  discoverAntigravityModels,
  invalidateAntigravityAuthCache,
  shellSingleQuote
} from "./antigravityModels.js";
import { stripAnsi } from "./cliOutput.js";
import { discoverCursorModels, parseCursorModelsOutput } from "./cursorModels.js";
import { cursorModeToCliArgs } from "./cursorMode.js";
import { alignProviderModel } from "./modelList.js";
import { checkHttpStatus, listHttpModels, runHttpProvider } from "./httpProvider.js";
import { addLog } from "./logStore.js";

export { getAuthSession };

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
      "",
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
      "read-only",
      ...modelArg("--model", model),
      "-"
    ]
  },
  cursor: {
    authArgs: ["login"],
    statusArgs: ["status"],
    modelsArgs: ["models"],
    runArgs: ({ model, cursorMode }) => [
      ...cursorModeToCliArgs(cursorMode),
      ...modelArg("--model", model)
    ]
  },
  antigravity: {
    authArgs: ["-p", "Reply with exactly: ok"],
    statusArgs: null,
    modelsArgs: ["models"],
    runArgs: ({ model }) => [...modelArg("--model", model)],
    printMode: true
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

function envForProvider(_provider) {
  const env = { ...process.env, NO_COLOR: "1" };
  const localBin = join(homedir(), ".local", "bin");
  env.PATH = [localBin, env.PATH].filter(Boolean).join(":");
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

  if (provider === "antigravity") {
    const result = checkAntigravityAuthStatus(providerConfig.command);
    if (!quiet || !result.ok) {
      addLog({
        type: "status",
        provider,
        level: result.ok ? "info" : "warn",
        message: result.output
      });
    }
    if (result.ok) {
      return { stdout: result.output, stderr: "", code: 0 };
    }
    const error = new Error(result.output);
    error.stderr = result.output;
    throw error;
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

export async function listModels(provider, providerConfig, { refresh = true } = {}) {
  const type = providerType(provider, providerConfig);

  if (type === "http") {
    return listHttpModels(provider, providerConfig);
  }

  let models = [];

  if (provider === "antigravity") {
    models = discoverAntigravityModels(providerConfig.command);
  } else if (provider === "claude") {
    models = await discoverClaudeModels(providerConfig.command);
    if (!models.length) {
      throw new Error("Claude model catalog unavailable — upgrade the claude CLI");
    }
  } else if (provider === "codex") {
    models = await discoverCodexModels(providerConfig.command, { refresh });
    if (!models.length) {
      throw new Error(
        "Codex CLI model catalog unavailable — upgrade codex or reinstall the codex snap"
      );
    }
  } else if (provider === "cursor") {
    models = await discoverCursorModels(providerConfig.command ?? "cursor-agent");
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

let oauthCodeSessions = new Map();
const authProcesses = new Map();

function trackAuthProcess(provider, child) {
  authProcesses.set(provider, { pid: child.pid, startedAt: Date.now() });
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
  if (provider === "antigravity") {
    return checkAntigravityAuthStatus().ok;
  }
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
    inProgress: authProcesses.has(provider) || oauthCodeSessions.has(provider)
  };
}

function providerLabel(provider) {
  return provider === "antigravity" ? "Antigravity" : provider;
}

function stopOAuthCodeSession(provider, reason) {
  const session = oauthCodeSessions.get(provider);
  if (!session) {
    return;
  }
  oauthCodeSessions.delete(provider);
  try {
    session.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  if (reason) {
    addLog({ type: "auth", provider, level: "info", message: reason });
  }
}

function buildOAuthScriptCommand(provider, providerConfig) {
  const spec = getProviderSpec(provider, providerConfig);
  const authArgs = spec?.authArgs ?? [];
  const command = providerConfig.command ?? provider;
  if (!authArgs.length) {
    return command;
  }
  const parts = [
    command,
    ...authArgs.map((arg) => (String(arg).startsWith("-") ? arg : shellSingleQuote(arg)))
  ];
  return parts.join(" ");
}

function startOAuthCodeAuth(provider, providerConfig, { force = false } = {}) {
  stopOAuthCodeSession(provider, `Replacing pending ${providerLabel(provider)} login`);
  clearAuthSession(provider);

  const child = spawn("script", ["-qfec", buildOAuthScriptCommand(provider, providerConfig), "/dev/null"], {
    cwd: process.cwd(),
    env: { ...authEnvForProvider(provider), NO_BROWSER: "true" },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let buffer = "";
  let urlLogged = false;

  const handleChunk = (chunk, level) => {
    const raw = chunk.toString();
    buffer += raw;
    const plain = stripAnsi(raw).trim();
    if (plain) {
      addLog({ type: "auth", provider, level, message: plain });
    }
    const session = ingestAuthOutput(provider, buffer);
    if (session?.url && !urlLogged) {
      urlLogged = true;
      addLog({
        type: "auth",
        provider,
        level: "info",
        message: `Open Google sign-in in your browser: ${session.url}`
      });
    }
  };

  child.stdout.on("data", (chunk) => handleChunk(chunk, "info"));
  child.stderr.on("data", (chunk) => handleChunk(chunk, "warn"));
  child.on("error", (error) => {
    oauthCodeSessions.delete(provider);
    addLog({ type: "auth", provider, level: "error", message: error.message });
  });

  trackAuthProcess(provider, child);
  oauthCodeSessions.set(provider, { child });
  child.on("exit", () => {
    oauthCodeSessions.delete(provider);
    if (provider === "antigravity") {
      invalidateAntigravityAuthCache();
      clearAuthSession(provider);
    }
  });

  addLog({
    type: "auth",
    provider,
    level: "info",
    message: `${providerLabel(provider)} login started. Watch Recent Activity for the Google link, sign in on your PC, then paste the authorization code in the dashboard.`
  });

  return { pid: child.pid, mode: "oauth-code" };
}

export function submitOAuthCodeAuth(provider, code) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) {
    throw new Error("Authorization code is required");
  }
  const session = oauthCodeSessions.get(provider);
  if (!session?.child?.stdin?.writable) {
    throw new Error(`No ${providerLabel(provider)} login in progress. Click Google sign-in first.`);
  }
  session.child.stdin.write(`${trimmed}\n`);
  addLog({
    type: "auth",
    provider,
    level: "info",
    message: "Authorization code submitted — waiting for login to finish."
  });
  if (provider === "antigravity") {
    invalidateAntigravityAuthCache();
  }
  return { ok: true };
}

export function submitAntigravityAuthCode(code) {
  return submitOAuthCodeAuth("antigravity", code);
}

function startAntigravityAuth(providerConfig, options) {
  return startOAuthCodeAuth("antigravity", providerConfig, options);
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

  if (provider === "antigravity") {
    return startAntigravityAuth(providerConfig, { force });
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
    stdio: ["ignore", "pipe", "pipe"]
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
    return parseCursorModelsOutput(stdout);
  }

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ id: line, name: line }));
}

export async function runProvider(provider, providerConfig, prompt, onChunk, options = {}) {
  const type = providerType(provider, providerConfig);

  if (type === "http") {
    return await runHttpProvider(provider, providerConfig, prompt, onChunk);
  }

  const spec = getProviderSpec(provider, providerConfig);
  const stdinMode = providerConfig.stdinMode ?? "prompt";

  if (provider === "antigravity" || spec.printMode) {
    const printCmd = buildAntigravityPrintCommand(
      providerConfig.command,
      prompt,
      providerConfig.model
    );
    return await runProcess({
      provider,
      command: "script",
      args: ["-qec", printCmd, "/dev/null"],
      stdinText: undefined,
      timeoutMs: providerConfig.timeoutMs,
      logType: "completion",
      onChunk
    });
  }

  return await runProcess({
    provider,
    command: providerConfig.command,
    args: spec.runArgs({ model: providerConfig.model, cursorMode: options.cursorMode }),
    stdinText: stdinMode === "none" ? undefined : prompt,
    timeoutMs: providerConfig.timeoutMs,
    logType: "completion",
    onChunk
  });
}

function runProcess({ provider, command, args, stdinText, timeoutMs, logType, onChunk, quiet = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: envForProvider(provider),
      stdio: ["pipe", "pipe", "pipe"]
    });
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
