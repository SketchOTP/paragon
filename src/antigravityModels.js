import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dedupeModels, splitTTYLines, stripAnsi } from "./cliOutput.js";

const ANTIGRAVITY_DIR = join(homedir(), ".gemini", "antigravity-cli");
const SETTINGS_PATH = join(ANTIGRAVITY_DIR, "settings.json");

const AUTH_NEEDLES = [
  "authentication required",
  "not logged into antigravity",
  "not signed in",
  "paste the authorization code",
  "please visit the url to log in",
  "please sign in to view available models",
  "waiting for authentication"
];

let authProbeCache = { at: 0, result: null };
const AUTH_PROBE_TTL_MS = 120_000;

function resolveBinary(command = "agy") {
  if (command.includes("/")) {
    return command;
  }
  const pathEnv = [join(homedir(), ".local", "bin"), process.env.PATH].filter(Boolean).join(":");
  try {
    return execSync(`command -v ${command}`, {
      encoding: "utf8",
      env: { ...process.env, PATH: pathEnv }
    }).trim();
  } catch {
    return null;
  }
}

export { stripAnsi };

const NOT_SIGNED_IN_MESSAGE =
  "Not signed in. Click Google sign-in, open the link on your PC, then paste the authorization code.";

function looksUnauthed(output) {
  const plain = stripAnsi(output).toLowerCase();
  if (!plain.trim()) {
    return false;
  }
  return AUTH_NEEDLES.some((needle) => plain.includes(needle));
}

function looksAuthedModelsOutput(output, exitCode = 0) {
  const plain = stripAnsi(output);
  if (!plain.trim() || looksUnauthed(plain)) {
    return false;
  }
  if (/^error:/im.test(plain)) {
    return false;
  }
  return parseAntigravityModelsOutput(plain).length > 0 || (exitCode === 0 && plain.trim().length > 0);
}

function cacheAuthResult(result) {
  authProbeCache = { at: Date.now(), result };
  return result;
}

export function parseAntigravityModelsOutput(output) {
  const models = [];
  for (const line of splitTTYLines(output)) {
    if (/^(Gemini|Claude|GPT-OSS)\b/i.test(line)) {
      models.push({ id: line, name: line });
    }
  }
  return dedupeModels(models);
}

function runAntigravityModels(command = "agy") {
  const binary = resolveBinary(command);
  if (!binary) {
    return { binary: null, text: "", exitCode: 1 };
  }

  const proc = spawnSync("script", ["-qec", `${binary} models`, "/dev/null"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1" }
  });

  return {
    binary,
    text: `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`,
    exitCode: proc.status ?? 1,
    error: proc.error
  };
}

/** Fast status — cached probe via `agy models` under a pseudo-TTY (avoids `agy -p` OAuth wait). */
export function checkAntigravityAuthStatus(command = "agy") {
  if (Date.now() - authProbeCache.at < AUTH_PROBE_TTL_MS && authProbeCache.result) {
    return authProbeCache.result;
  }

  const { binary, text, exitCode, error } = runAntigravityModels(command);
  if (!binary) {
    return cacheAuthResult({
      ok: false,
      output: "Antigravity CLI (`agy`) not found. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash"
    });
  }

  if (looksUnauthed(text)) {
    return cacheAuthResult({ ok: false, output: NOT_SIGNED_IN_MESSAGE });
  }

  if (looksAuthedModelsOutput(text, exitCode)) {
    return cacheAuthResult({ ok: true, output: "Signed in with Google (Antigravity CLI)" });
  }

  if (error?.code === "ETIMEDOUT") {
    return cacheAuthResult({
      ok: false,
      output: "Antigravity auth probe timed out — click Google sign-in in the dashboard."
    });
  }

  return cacheAuthResult({ ok: false, output: NOT_SIGNED_IN_MESSAGE });
}

export function invalidateAntigravityAuthCache() {
  authProbeCache = { at: 0, result: null };
}

export function loadAntigravitySettingsModel() {
  if (!existsSync(SETTINGS_PATH)) {
    return null;
  }
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return typeof settings.model === "string" ? settings.model : null;
  } catch {
    return null;
  }
}

export function discoverAntigravityModels(command = "agy") {
  const { binary, text, exitCode, error } = runAntigravityModels(command);
  if (!binary) {
    throw new Error(
      "Antigravity CLI (`agy`) not found. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash"
    );
  }

  if (looksUnauthed(text)) {
    throw new Error(NOT_SIGNED_IN_MESSAGE);
  }

  const models = parseAntigravityModelsOutput(text);
  if (models.length) {
    return models;
  }

  if (error?.code === "ETIMEDOUT") {
    throw new Error("Antigravity model list timed out — try again from the dashboard.");
  }

  throw new Error(
    exitCode === 0
      ? "Antigravity model list returned no models"
      : "Antigravity model list failed — sign in and retry"
  );
}

export function shellSingleQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

export function buildAntigravityPrintCommand(command, prompt, model) {
  const binary = resolveBinary(command) ?? command;
  const parts = [binary, "-p", shellSingleQuote(prompt)];
  if (model) {
    parts.push("--model", shellSingleQuote(model));
  }
  return parts.join(" ");
}
