import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeCodexModelEntries, parseCodexModelsCatalog } from "./modelList.js";

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const DISCOVERY_ARG_SETS = [
  ["debug", "models"],
  ["debug", "models", "--bundled"]
];

export function codexHomeDir() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function runCodex(command, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

function resolveCodexBinary(command = "codex") {
  if (command.includes("/")) {
    return realpathSync(command);
  }
  const snapBinary = `/snap/${command}/current/bin/${command}`;
  if (existsSync(snapBinary)) {
    return realpathSync(snapBinary);
  }
  const which = execSync(`command -v ${command}`, {
    encoding: "utf8",
    env: process.env
  }).trim();
  return realpathSync(which);
}

function parseSemver(version) {
  const match = String(version ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return right[index] - left[index];
    }
  }
  return 0;
}

/** Prefer the newest client_version — older CLI builds under-report account models. */
export function resolveCodexClientVersion({ homeDir = codexHomeDir(), command = "codex" } = {}) {
  const candidates = [];

  try {
    const cachePath = join(homeDir, "models_cache.json");
    if (existsSync(cachePath)) {
      const payload = JSON.parse(readFileSync(cachePath, "utf8"));
      if (payload.client_version) {
        candidates.push(String(payload.client_version));
      }
    }
  } catch {
    // Ignore unreadable cache metadata.
  }

  try {
    const output = execSync(`${command} --version`, {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      candidates.push(match[1]);
    }
  } catch {
    // Ignore missing or non-parseable CLI version output.
  }

  if (process.env.CODEX_CLIENT_VERSION) {
    candidates.push(String(process.env.CODEX_CLIENT_VERSION));
  }

  candidates.sort(compareSemverDesc);
  return candidates[0] ?? null;
}

export function loadCodexAuth(homeDir = codexHomeDir()) {
  try {
    const authPath = join(homeDir, "auth.json");
    if (!existsSync(authPath)) {
      return null;
    }
    const payload = JSON.parse(readFileSync(authPath, "utf8"));
    const token =
      payload.tokens?.access_token ??
      payload.tokens?.id_token ??
      payload.OPENAI_API_KEY ??
      null;
    if (!token) {
      return null;
    }

    let accountId = payload.chatgpt_account_id ?? null;
    if (!accountId && payload.tokens?.id_token) {
      const [, body] = payload.tokens.id_token.split(".");
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
    }

    return { token, accountId, authMode: payload.auth_mode ?? null };
  } catch {
    return null;
  }
}

export function loadCodexCachePayload(homeDir = codexHomeDir()) {
  try {
    const cachePath = join(homeDir, "models_cache.json");
    if (!existsSync(cachePath)) {
      return null;
    }
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

/** Account-scoped catalog written by Codex CLI after login (`~/.codex/models_cache.json`). */
export function loadCodexModelsCache(homeDir = codexHomeDir()) {
  const payload = loadCodexCachePayload(homeDir);
  if (!payload) {
    return [];
  }
  return normalizeCodexModelEntries(payload.models ?? payload);
}

function persistCodexModelsCache(homeDir, payload) {
  try {
    const cachePath = join(homeDir, "models_cache.json");
    writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Non-fatal — RouterBot can still use the in-memory list.
  }
}

/** Live account catalog from ChatGPT Codex backend (`/backend-api/codex/models`). */
export async function fetchCodexModelsFromApi({
  homeDir = codexHomeDir(),
  command = "codex",
  clientVersion,
  persistCache = true
} = {}) {
  const auth = loadCodexAuth(homeDir);
  if (!auth?.token) {
    return [];
  }

  const version = clientVersion ?? resolveCodexClientVersion({ homeDir, command });
  if (!version) {
    throw new Error("Codex client_version unavailable — run `codex login` or upgrade the Codex CLI");
  }

  const headers = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json"
  };
  if (auth.accountId) {
    headers["ChatGPT-Account-Id"] = auth.accountId;
  }

  const response = await fetch(
    `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(version)}`,
    {
      headers,
      signal: AbortSignal.timeout(30_000)
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Codex models HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const payload = await response.json();
  const rawModels = payload.models ?? payload.data ?? payload;
  if (persistCache && Array.isArray(rawModels) && rawModels.length) {
    persistCodexModelsCache(homeDir, {
      fetched_at: new Date().toISOString(),
      etag: response.headers.get("etag"),
      client_version: version,
      models: rawModels
    });
  }

  return normalizeCodexModelEntries(rawModels);
}

/** Bundled catalog embedded in the codex binary (same source as `codex debug models --bundled`). */
export function loadCodexBundledCatalog(command = "codex") {
  try {
    const binaryPath = resolveCodexBinary(command);
    const text = readFileSync(binaryPath).toString("latin1");
    const models = [];
    const seen = new Set();
    const slugPattern = /"slug": "([^"]+)"/g;
    let match;
    while ((match = slugPattern.exec(text)) !== null) {
      const id = match[1];
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push({ id, name: id });
    }
    return models;
  } catch {
    return [];
  }
}

async function discoverCodexModelsViaCli(command) {
  for (const args of DISCOVERY_ARG_SETS) {
    try {
      const result = await runCodex(command, args);
      const models = parseCodexModelsCatalog(result.stdout);
      if (models.length) {
        return models;
      }
    } catch {
      // Try the next discovery command shape.
    }
  }
  return [];
}

/** Account catalog from live API/CLI; cache-only when refresh is false. */
export async function discoverCodexModels(command = "codex", { refresh = false } = {}) {
  if (refresh) {
    try {
      const apiModels = await fetchCodexModelsFromApi({ command, persistCache: true });
      if (apiModels.length) {
        return apiModels;
      }
    } catch {
      // Fall through to CLI/cache discovery.
    }

    const cliModels = await discoverCodexModelsViaCli(command);
    if (cliModels.length) {
      return cliModels;
    }

    const refreshedCache = loadCodexModelsCache();
    if (refreshedCache.length) {
      return refreshedCache;
    }
  } else {
    const cached = loadCodexModelsCache();
    if (cached.length) {
      return cached;
    }
  }

  const cliModels = await discoverCodexModelsViaCli(command);
  if (cliModels.length) {
    return cliModels;
  }

  return loadCodexBundledCatalog(command);
}
