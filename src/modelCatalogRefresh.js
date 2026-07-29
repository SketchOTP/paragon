/**
 * Provider discovery + bounded validation orchestration (PARAGON-D-004C).
 *
 * Each refreshProviderCatalog() call is an authoritative replacement, never
 * an append: the previous candidate set for that provider is fully
 * superseded by what this refresh confirms, with anything no longer
 * present demoted to "retired" (see replaceProviderModels in
 * modelCatalog.js). Static source lists and installed-binary scans are
 * treated as candidate discovery only — they can nominate a model, they
 * cannot grant it automatic eligibility. Only an authoritative
 * account-aware list call, or a bounded exact-model execution probe, can
 * do that.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CLAUDE_DOCUMENTED_MODELS, loadClaudeBundledCatalog } from "./claudeModels.js";
import { loadCodexBundledCatalog } from "./codexModels.js";
import { parseCodexModelsCatalog } from "./modelList.js";
import { parseModels, runProvider } from "./cli.js";
import { getNeutralExecutionDir } from "./executionSandbox.js";
import { openAiBaseUrl } from "./httpProvider.js";
import {
  classifyModelFailure,
  replaceProviderModels,
  saveCatalog
} from "./modelCatalog.js";
import { addLog } from "./logStore.js";

const execFileAsync = promisify(execFile);

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const PROBE_PROMPT = "Reply with exactly one word: ok";

/** `<command> --version`, bounded — used to invalidate stale validations when the installed CLI changes underneath them. */
export async function getCliVersion(command, timeoutMs = 10000) {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: timeoutMs, env: process.env });
    return stdout.trim().slice(0, 200) || null;
  } catch {
    return null;
  }
}

function runCliCommand(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: getNeutralExecutionDir(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const error = new Error(stderr.trim() || `${command} exited ${code}`);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

/** Rejects headings/flags/commentary — only lines that look like a real "id - name" or bare-id model record survive. */
function parseAgyModelsOutput(stdout) {
  const seen = new Set();
  const models = [];
  for (const rawLine of String(stdout ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("-") || line.startsWith("#") || line.startsWith("--")) {
      continue;
    }
    if (/^(available|usage|options|flags|models?:?)$/i.test(line)) {
      continue;
    }
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)\s*(?:-\s*(.+))?$/i);
    if (!match) {
      continue;
    }
    const id = match[1];
    if (!/gemini/i.test(id) && !match[2]) {
      // Bare tokens with no gemini-family shape and no display name are
      // most likely stray CLI chrome, not a model record.
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ id, name: (match[2] || id).trim() });
  }
  return models;
}

/** Candidate sources for Claude — always candidate-only; there is no account-aware Claude model-list API (see claudeModels.js). */
async function claudeCandidates(command) {
  const documented = CLAUDE_DOCUMENTED_MODELS.map((m) => ({
    ...m,
    isAlias: CLAUDE_ALIASES.has(m.id),
    discoverySource: "documented_candidate"
  }));
  const bundled = loadClaudeBundledCatalog(command).map((m) => ({
    ...m,
    isAlias: CLAUDE_ALIASES.has(m.id),
    discoverySource: "binary_candidate"
  }));
  const byId = new Map();
  for (const model of [...documented, ...bundled]) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

/**
 * Codex: `codex debug models` (no --bundled) is treated as authoritative
 * exposed — it queries the installed CLI's live resolution, not just the
 * embedded catalog. `--bundled` output is candidate-only.
 */
async function codexCandidates(command) {
  let live = [];
  try {
    const stdout = await runCliCommand(command, ["debug", "models"], 60000);
    live = parseCodexModelsCatalog(stdout);
  } catch {
    live = [];
  }
  const bundled = loadCodexBundledCatalog(command);
  const liveIds = new Set(live.map((m) => m.id));
  return [
    ...live.map((m) => ({ ...m, isAlias: false, discoverySource: "cli_command" })),
    ...bundled.filter((m) => !liveIds.has(m.id)).map((m) => ({ ...m, isAlias: false, discoverySource: "binary_candidate" }))
  ];
}

/** `cursor-agent models` is the primary/authoritative discovery source per PARAGON-D-004C, but still gets bounded validation below before eligibility. */
async function cursorCandidates(command) {
  const stdout = await runCliCommand(command, ["models"], 60000);
  return parseModels("cursor", stdout).map((m) => ({ ...m, isAlias: false, discoverySource: "cli_command" }));
}

/** `agy models` authoritative catalog — parsed defensively to reject commentary/flags (see parseAgyModelsOutput). */
async function antigravityCandidates(command) {
  const stdout = await runCliCommand(command, ["models"], 60000);
  return parseAgyModelsOutput(stdout).map((m) => ({ ...m, isAlias: false, discoverySource: "cli_command" }));
}

async function httpCandidates(providerConfig) {
  const baseUrl = openAiBaseUrl(providerConfig.baseUrl);
  if (!baseUrl) {
    throw new Error("baseUrl is not configured");
  }
  const headers = {};
  if (providerConfig.apiKey) {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }
  const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} listing models at ${baseUrl}/models`);
  }
  const payload = await response.json();
  const models = (payload.data ?? []).map((m) => ({ id: m.id, name: m.id }));
  return models.map((m) => ({ ...m, isAlias: false, discoverySource: "http_models_endpoint" }));
}

/** Real bounded exact-model acceptance probe — minimal prompt, short timeout, classified on failure. */
async function defaultProbe(provider, providerConfig, modelId, { timeoutMs = 45000 } = {}) {
  try {
    await runProvider(
      provider,
      { ...providerConfig, model: modelId, timeoutMs },
      PROBE_PROMPT,
      undefined,
      { cwd: getNeutralExecutionDir() }
    );
    return { success: true };
  } catch (error) {
    return { success: false, classification: classifyModelFailure(error) };
  }
}

const CANDIDATE_SOURCES = {
  claude: (providerConfig) => claudeCandidates(providerConfig.command),
  codex: (providerConfig) => codexCandidates(providerConfig.command),
  cursor: (providerConfig) => cursorCandidates(providerConfig.command),
  antigravity: (providerConfig) => antigravityCandidates(providerConfig.command)
};

/** Sources that already represent a current, account-aware, authoritative call — no additional probe required before eligibility. */
const AUTHORITATIVE_SOURCES = new Set(["cli_command", "http_models_endpoint"]);

/**
 * Refreshes exactly one provider's catalog bucket: gathers candidates,
 * bounded-validates the ones that need it, and authoritatively replaces
 * that provider's stored model set. Never merges into the previous set —
 * see replaceProviderModels(). Returns diff counts for the caller to log
 * and persist in the schedule's outcome summary.
 */
export async function refreshProviderCatalog(provider, providerConfig, catalog, opts = {}) {
  const {
    maxValidationProbesPerProvider = 10,
    probeFn = defaultProbe,
    now = new Date().toISOString()
  } = opts;

  let candidates;
  if (providerConfig.type === "http") {
    candidates = await httpCandidates(providerConfig);
  } else {
    const source = CANDIDATE_SOURCES[provider];
    if (!source) {
      throw new Error(`No model-catalog discovery source for provider: ${provider}`);
    }
    candidates = await source(providerConfig);
  }

  const cliVersion = providerConfig.type === "http" ? null : await getCliVersion(providerConfig.command);
  const previousCliVersion = catalog.providers?.[provider]?.cliVersion ?? null;
  const cliVersionChanged = cliVersion != null && previousCliVersion != null && cliVersion !== previousCliVersion;
  if (cliVersionChanged) {
    addLog({
      type: "models",
      provider,
      level: "info",
      message: `Installed CLI version changed (${previousCliVersion} -> ${cliVersion}) — every candidate is re-validated fresh this cycle, nothing carried forward`
    });
  }

  const needsValidation = candidates.filter((c) => !AUTHORITATIVE_SOURCES.has(c.discoverySource) && !c.isAlias);
  const boundedForValidation = new Set(needsValidation.slice(0, maxValidationProbesPerProvider).map((c) => c.id));

  const nextEntries = [];
  let rejectedNow = 0;
  for (const candidate of candidates) {
    if (AUTHORITATIVE_SOURCES.has(candidate.discoverySource)) {
      nextEntries.push({
        modelId: candidate.id,
        displayName: candidate.name,
        isAlias: false,
        state: "exposed",
        discoverySource: candidate.discoverySource
      });
      continue;
    }
    if (candidate.isAlias) {
      // Aliases are recorded (visible in the dashboard/history) but never
      // auto-eligible from discovery alone — an alias resolving is not
      // proof any specific concrete model is available.
      nextEntries.push({
        modelId: candidate.id,
        displayName: candidate.name,
        isAlias: true,
        state: "unknown",
        discoverySource: candidate.discoverySource
      });
      continue;
    }
    if (!boundedForValidation.has(candidate.id)) {
      // Outside this cycle's probe budget — stays a candidate only. Every
      // candidate here is re-derived fresh this cycle (see
      // replaceProviderModels' authoritative-replace semantics), so a CLI
      // version change never needs special-casing beyond the log above:
      // there is no "trust the old validation" shortcut to invalidate.
      nextEntries.push({
        modelId: candidate.id,
        displayName: candidate.name,
        isAlias: false,
        state: "unknown",
        discoverySource: candidate.discoverySource
      });
      continue;
    }
    const result = await probeFn(provider, providerConfig, candidate.id, {});
    if (result.success) {
      nextEntries.push({
        modelId: candidate.id,
        displayName: candidate.name,
        isAlias: false,
        state: "validated",
        discoverySource: candidate.discoverySource
      });
    } else {
      rejectedNow += 1;
      addLog({
        type: "models",
        provider,
        level: "warn",
        message: `Model catalog: ${candidate.id} rejected during validation (${result.classification})`
      });
      nextEntries.push({
        modelId: candidate.id,
        displayName: candidate.name,
        isAlias: false,
        state: STATE_FOR_REJECTION(result.classification),
        discoverySource: candidate.discoverySource
      });
    }
  }

  const previousIds = new Set(Object.keys(catalog.providers?.[provider]?.models ?? {}));
  const nextIds = new Set(nextEntries.map((e) => e.modelId));
  const added = [...nextIds].filter((id) => !previousIds.has(id)).length;
  const removed = [...previousIds].filter((id) => !nextIds.has(id)).length;

  replaceProviderModels(catalog, provider, nextEntries, { now, cliVersion });

  return { added, removed, rejectedNow, candidateCount: candidates.length };
}

function STATE_FOR_REJECTION(classification) {
  switch (classification) {
    case "MODEL_NOT_FOUND":
    case "MODEL_REJECTED":
      return "rejected";
    case "MODEL_UNAVAILABLE":
      return "unavailable";
    case "AUTHENTICATION_FAILED":
      return "authentication_blocked";
    case "QUOTA_EXHAUSTED":
      return "quota_blocked";
    case "ENTITLEMENT_REQUIRED":
      return "entitlement_blocked";
    case "CONFIGURATION_ERROR":
      return "configuration_blocked";
    case "PROVIDER_OFFLINE":
      return "provider_offline";
    default:
      // Transient failure during a validation probe: don't fabricate a
      // hard-rejected state off one blip — leave it unknown, eligible for
      // re-validation next cycle.
      return "unknown";
  }
}

/**
 * Refreshes every enabled provider, one at a time by default
 * (maxConcurrentProviderRefreshes), continuing past any single provider's
 * discovery failure so one broken CLI never blocks the rest of the fleet.
 */
export async function refreshAllProviders(config, catalog, opts = {}) {
  const { maxConcurrentProviderRefreshes = 1, providerTimeoutMs = 120000 } = opts;
  const enabled = Object.entries(config.providers ?? {}).filter(([, cfg]) => cfg.enabled);
  const outcomes = {};

  async function refreshOne([provider, providerConfig]) {
    // A bare `Promise.race` never cancels the losing timer — left as-is,
    // the setTimeout below would keep a live handle (up to
    // providerTimeoutMs) even after refreshProviderCatalog already
    // resolved, holding the process open for no reason.
    let timeoutHandle;
    const timeoutGuard = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`${provider} catalog refresh timed out`)), providerTimeoutMs);
    });
    try {
      const result = await Promise.race([refreshProviderCatalog(provider, providerConfig, catalog, opts), timeoutGuard]);
      outcomes[provider] = { ok: true, ...result };
      addLog({
        type: "models",
        provider,
        level: "info",
        message: `Catalog refresh: +${result.added} -${result.removed} (${result.rejectedNow} rejected this cycle)`
      });
    } catch (error) {
      outcomes[provider] = { ok: false, error: error.message };
      addLog({ type: "models", provider, level: "warn", message: `Catalog refresh failed (kept previous entries): ${error.message}` });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  if (maxConcurrentProviderRefreshes <= 1) {
    for (const entry of enabled) {
      await refreshOne(entry);
    }
  } else {
    const queue = [...enabled];
    const workers = Array.from({ length: Math.min(maxConcurrentProviderRefreshes, queue.length) }, async () => {
      while (queue.length) {
        const entry = queue.shift();
        if (entry) {
          await refreshOne(entry);
        }
      }
    });
    await Promise.all(workers);
  }

  return outcomes;
}

/**
 * Full refresh cycle with a persisted lock (schedule.refreshing) so two
 * processes/ticks can never run overlapping refreshes. A lock older than
 * `staleLockMinutes` is treated as abandoned (crashed process) and
 * overridden rather than deadlocking the catalog forever.
 */
export async function runFullRefresh(config, opts = {}) {
  const { staleLockMinutes = 30, refreshIntervalHours = 24 } = opts;
  let catalog = opts.catalog ?? (await (await import("./modelCatalog.js")).loadCatalog());

  if (catalog.schedule.refreshing) {
    const startedAt = catalog.schedule.lastRefreshStartedAt ? Date.parse(catalog.schedule.lastRefreshStartedAt) : 0;
    const ageMinutes = (Date.now() - startedAt) / 60000;
    if (ageMinutes < staleLockMinutes) {
      return { skipped: true, reason: "refresh already in progress" };
    }
    addLog({ type: "models", provider: "paragon", level: "warn", message: `Model catalog refresh lock stale (${ageMinutes.toFixed(1)}m) — overriding` });
  }

  const startedAt = new Date().toISOString();
  catalog.schedule.refreshing = true;
  catalog.schedule.lastRefreshStartedAt = startedAt;
  await saveCatalog(catalog);

  let outcomes = {};
  try {
    outcomes = await refreshAllProviders(config, catalog, opts);
    catalog.generation += 1;
    catalog.schedule.lastSuccessfulRefreshAt = new Date().toISOString();
  } finally {
    const completedAt = new Date().toISOString();
    catalog.schedule.refreshing = false;
    catalog.schedule.lastRefreshCompletedAt = completedAt;
    catalog.schedule.nextRefreshAt = new Date(Date.now() + refreshIntervalHours * 3_600_000).toISOString();
    await saveCatalog(catalog);
  }

  return { skipped: false, outcomes, catalog };
}
