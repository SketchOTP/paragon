import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";

/**
 * Documented Claude Code models (help center + common aliases). This is a
 * fallback floor only — loadClaudeBundledCatalog() below (a string scan of
 * the actually-installed binary) is what surfaces new releases without a
 * code change here. Verified against the installed claude binary
 * (2.1.220) on 2026-07-28: claude-opus-5, claude-sonnet-5, claude-fable-5,
 * and claude-mythos-5 are all real, live strings in that build.
 */
export const CLAUDE_DOCUMENTED_MODELS = [
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-fable-5", name: "Fable 5" },
  { id: "claude-mythos-5", name: "Mythos 5" },
  { id: "claude-opus-4-8", name: "Opus 4.8" },
  { id: "claude-opus-4-7", name: "Opus 4.7" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
  { id: "claude-opus-4-6", name: "Opus 4.6" },
  { id: "claude-opus-4-5-20251101", name: "Opus 4.5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", name: "Sonnet 4.5" },
  { id: "claude-sonnet-4-20250514", name: "Sonnet 4" },
  { id: "claude-opus-4-20250514", name: "Opus 4" },
  { id: "claude-3-7-sonnet-20250219", name: "Sonnet 3.7" },
  { id: "claude-3-5-haiku-20241022", name: "Haiku 3.5" },
  { id: "opus", name: "Opus (alias, resolves to latest)" },
  { id: "sonnet", name: "Sonnet (alias, resolves to latest)" },
  { id: "haiku", name: "Haiku (alias, resolves to latest)" },
  { id: "fable", name: "Fable (alias, resolves to latest)" }
];

// There is no real "list models" subcommand for the claude CLI — `claude
// --help` confirms the only commands are agents/auth/auto-mode/doctor/
// install/mcp/plugin/project/setup-token/ultrareview/update. The previous
// ["model","list"]/["models"] arg sets here were never real subcommands:
// they got silently treated as a chat prompt (one returned a conversational
// answer, the other hung until timeout). Verified by hand, not assumed.
// loadClaudeBundledCatalog() below is the only real discovery mechanism.
const BINARY_MODEL_PATTERN = /claude-(?:opus|sonnet|haiku|fable|mythos)-[a-z0-9.-]+/g;

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
  if (!/^claude-(opus|sonnet|haiku|fable|mythos)-/.test(id)) {
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
  const documented = CLAUDE_DOCUMENTED_MODELS.find((model) => model.id === id);
  if (documented) {
    return documented.name;
  }
  return id.replace(/^claude-/, "").replace(/-/g, " ");
}

export function parseClaudeModelListOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return [];
  }

  try {
    const payload = JSON.parse(text);
    const entries = Array.isArray(payload) ? payload : (payload.models ?? payload.data ?? []);
    if (Array.isArray(entries) && entries.length) {
      return entries
        .map((entry) => {
          const id = entry.id ?? entry.model ?? entry.slug;
          if (!id) {
            return null;
          }
          return {
            id: String(id),
            name: entry.name ?? entry.display_name ?? displayNameForClaudeModel(String(id))
          };
        })
        .filter(Boolean);
    }
  } catch {
    // Plain-text output below.
  }

  const models = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const idMatch = trimmed.match(/\b(claude-(?:opus|sonnet|haiku|fable|mythos)-[a-z0-9.-]+)\b/i);
    if (idMatch && isClaudeModelId(idMatch[1]) && !seen.has(idMatch[1])) {
      seen.add(idMatch[1]);
      models.push({ id: idMatch[1], name: displayNameForClaudeModel(idMatch[1]) });
    }
  }
  return models;
}

export function mergeClaudeModelCatalogs(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const model of list ?? []) {
      if (!model?.id) {
        continue;
      }
      const existing = byId.get(model.id);
      byId.set(model.id, {
        id: model.id,
        name: existing?.name && existing.name !== existing.id ? existing.name : model.name || model.id
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Model IDs embedded in the installed claude binary. */
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
    return models;
  } catch {
    return [];
  }
}

export async function discoverClaudeModels(command = "claude") {
  const bundled = mergeClaudeModelCatalogs(
    CLAUDE_DOCUMENTED_MODELS,
    loadClaudeBundledCatalog(command)
  );
  if (bundled.length) {
    return bundled;
  }

  return CLAUDE_DOCUMENTED_MODELS;
}
