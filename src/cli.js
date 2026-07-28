import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { authFlowFor } from "./authFlows.js";
import { clearAuthSession, getAuthSession, ingestAuthOutput } from "./authSessions.js";
import { discoverClaudeModels } from "./claudeModels.js";
import { discoverCodexModels } from "./codexModels.js";
import { checkGeminiAuthStatus, loadGeminiCliModelCatalog } from "./geminiModels.js";
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
    runArgs: ({ model }) => [
      "--print",
      "--trust",
      "--mode",
      "ask",
      ...modelArg("--model", model)
    ]
  },
  gemini: {
    authArgs: [],
    statusArgs: null,
    modelsArgs: null,
    runArgs: ({ model }) => [
      "--skip-trust",
      "--approval-mode",
      "plan",
      "-o",
      "text",
      ...modelArg("-m", model)
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
  if (provider !== "gemini") {
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

  if (provider === "gemini") {
    const result = checkGeminiAuthStatus();
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

export async function listModels(provider, providerConfig) {
  const type = providerType(provider, providerConfig);

  if (type === "http") {
    return listHttpModels(provider, providerConfig);
  }

  let models = [];

  if (provider === "gemini") {
    models = loadGeminiCliModelCatalog(providerConfig.command) ?? [];
    if (!models.length) {
      throw new Error("Gemini CLI model catalog unavailable — reinstall or upgrade the gemini CLI");
    }
  } else if (provider === "claude") {
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

let geminiAuthSession = null;
const authProcesses = new Map();

const GEMINI_DIR = join(homedir(), ".gemini");

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
  if (provider === "gemini") {
    return checkGeminiAuthStatus().ok;
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

function clearGeminiCredentials() {
  for (const name of ["oauth_creds.json"]) {
    try {
      unlinkSync(join(GEMINI_DIR, name));
    } catch {
      // ignore missing file
    }
  }
}

export function getAuthState(provider) {
  return {
    provider,
    flow: authFlowFor(provider),
    session: getAuthSession(provider),
    inProgress: authProcesses.has(provider) || (provider === "gemini" && Boolean(geminiAuthSession))
  };
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

function stopGeminiAuthSession(reason) {
  if (!geminiAuthSession) {
    return;
  }
  const { child } = geminiAuthSession;
  geminiAuthSession = null;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  if (reason) {
    addLog({ type: "auth", provider: "gemini", level: "info", message: reason });
  }
}

function startGeminiAuth(providerConfig, { force = false } = {}) {
  stopGeminiAuthSession("Replacing pending Gemini login");
  clearAuthSession("gemini");

  if (force) {
    clearGeminiCredentials();
  }

  const child = spawn("script", ["-qfec", providerConfig.command, "/dev/null"], {
    cwd: process.cwd(),
    env: { ...authEnvForProvider("gemini"), NO_BROWSER: "true" },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let buffer = "";
  let urlLogged = false;

  const handleChunk = (chunk, level) => {
    const raw = chunk.toString();
    buffer += raw;
    const plain = stripAnsi(raw).trim();
    if (plain) {
      addLog({ type: "auth", provider: "gemini", level, message: plain });
    }
    const session = ingestAuthOutput("gemini", buffer);
    if (session?.url && !urlLogged) {
      urlLogged = true;
      addLog({
        type: "auth",
        provider: "gemini",
        level: "info",
        message: `Open Google sign-in in your browser: ${session.url}`
      });
    }
  };

  child.stdout.on("data", (chunk) => handleChunk(chunk, "info"));
  child.stderr.on("data", (chunk) => handleChunk(chunk, "warn"));
  child.on("error", (error) => {
    geminiAuthSession = null;
    addLog({ type: "auth", provider: "gemini", level: "error", message: error.message });
  });

  trackAuthProcess("gemini", child);

  geminiAuthSession = { child };
  child.on("exit", () => {
    geminiAuthSession = null;
  });

  addLog({
    type: "auth",
    provider: "gemini",
    level: "info",
    message:
      "Gemini login started (manual OAuth). Watch Recent Activity for the Google link, sign in on your PC, then paste the authorization code in the dashboard."
  });

  return { pid: child.pid, mode: "oauth-code" };
}

export function submitGeminiAuthCode(code) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) {
    throw new Error("Authorization code is required");
  }
  if (!geminiAuthSession?.child?.stdin?.writable) {
    throw new Error("No Gemini login in progress. Click Google sign-in first.");
  }
  geminiAuthSession.child.stdin.write(`${trimmed}\n`);
  addLog({
    type: "auth",
    provider: "gemini",
    level: "info",
    message: "Authorization code submitted — waiting for Gemini to finish login."
  });
  return { ok: true };
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

  if (provider === "gemini") {
    return startGeminiAuth(providerConfig, { force });
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
    args: spec.runArgs({ model: providerConfig.model }),
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
