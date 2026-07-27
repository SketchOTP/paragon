import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dedupeModels, splitTTYLines } from "./cliOutput.js";

/** Display-name hints when the API/CLI only returns ids. */
export const CLAUDE_DISPLAY_NAMES = {
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-5-20251101": "Opus 4.5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "claude-opus-4-1-20250805": "Opus 4.1",
  opus: "Opus (alias)",
  sonnet: "Sonnet (alias)",
  haiku: "Haiku (alias)",
  fable: "Fable (alias)"
};

const DISCOVERY_ARG_SETS = [
  ["model", "list"],
  ["models"]
];

const BINARY_MODEL_PATTERN = /claude-(?:opus|sonnet|haiku|fable)-[a-z0-9.-]+/g;

export function claudeHomeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function claudeCredentialsPath(homeDir = claudeHomeDir()) {
  return join(homeDir, ".credentials.json");
}

function runClaude(command, args, timeoutMs = 15000) {
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

function resolveClaudeBinary(command = "claude") {
  if (command.includes("/")) {
    return realpathSync(command);
  }
  const which = execSync(`command -v ${command}`, {
    encoding: "utf8",
    env: process.env
  }).trim();
  return realpathSync(which);
}

function isClaudeModelId(id) {
  if (!/^claude-(opus|sonnet|haiku|fable)-/.test(id)) {
    return false;
  }
  if (id.endsWith("-v1") || id.endsWith("-fast")) {
    return false;
  }
  if (/claude-(code|api|ai|cli)/.test(id)) {
    return false;
  }
  return true;
}

function displayNameForClaudeModel(id) {
  return CLAUDE_DISPLAY_NAMES[id] ?? id.replace(/^claude-/, "").replace(/-/g, " ");
}

export function parseAnthropicModelsResponse(payload) {
  const entries = payload?.data ?? payload?.models ?? [];
  if (!Array.isArray(entries)) {
    return [];
  }
  return dedupeModels(
    entries
      .map((entry) => {
        const id = entry.id ?? entry.model ?? entry.slug;
        if (!id) {
          return null;
        }
        return {
          id: String(id),
          name: entry.display_name ?? entry.displayName ?? entry.name ?? displayNameForClaudeModel(String(id))
        };
      })
      .filter(Boolean)
  );
}

export function parseClaudeModelListOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return [];
  }

  try {
    const payload = JSON.parse(text);
    const parsed = parseAnthropicModelsResponse(payload);
    if (parsed.length) {
      return parsed;
    }
  } catch {
    // Plain-text output below.
  }

  const models = [];
  const seen = new Set();
  for (const line of splitTTYLines(text)) {
    const idMatch = line.match(/\b(claude-(?:opus|sonnet|haiku|fable)-[a-z0-9.-]+)\b/i);
    if (idMatch && isClaudeModelId(idMatch[1]) && !seen.has(idMatch[1])) {
      seen.add(idMatch[1]);
      models.push({ id: idMatch[1], name: displayNameForClaudeModel(idMatch[1]) });
    }
  }
  return dedupeModels(models);
}

function loadClaudeOAuthToken(homeDir = claudeHomeDir()) {
  try {
    const credentialsPath = claudeCredentialsPath(homeDir);
    if (!existsSync(credentialsPath)) {
      return null;
    }
    const payload = JSON.parse(readFileSync(credentialsPath, "utf8"));
    return payload?.claudeAiOauth?.accessToken ?? payload?.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Account-scoped catalog from Anthropic /v1/models using Claude Code OAuth. */
export async function fetchClaudeModelsFromApi(homeDir = claudeHomeDir()) {
  const token = loadClaudeOAuthToken(homeDir);
  if (!token) {
    return [];
  }

  const response = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    throw new Error(`Anthropic models HTTP ${response.status}`);
  }

  return parseAnthropicModelsResponse(await response.json());
}

/** Model IDs embedded in the installed claude binary — last-resort fallback only. */
export function loadClaudeBundledCatalog(command = "claude") {
  try {
    const binaryPath = resolveClaudeBinary(command);
    const text = readFileSync(binaryPath).toString("latin1");
    const seen = new Set();
    const models = [];
    for (const match of text.matchAll(BINARY_MODEL_PATTERN)) {
      const id = match[0];
      if (!isClaudeModelId(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push({ id, name: displayNameForClaudeModel(id) });
    }
    return dedupeModels(models);
  } catch {
    return [];
  }
}

export async function discoverClaudeModels(command = "claude") {
  try {
    const apiModels = await fetchClaudeModelsFromApi();
    if (apiModels.length) {
      return apiModels;
    }
  } catch {
    // Fall through to CLI discovery.
  }

  for (const args of DISCOVERY_ARG_SETS) {
    try {
      const result = await runClaude(command, args, 5000);
      const models = parseClaudeModelListOutput(result.stdout);
      if (models.length) {
        return models;
      }
    } catch {
      // Try the next discovery command shape.
    }
  }

  const bundled = loadClaudeBundledCatalog(command);
  if (bundled.length) {
    return bundled;
  }

  throw new Error(
    "Claude model catalog unavailable — sign in with `claude auth login` or set ANTHROPIC_API_KEY"
  );
}
