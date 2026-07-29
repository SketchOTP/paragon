/**
 * Model-catalog state machine and persistent store (PARAGON-D-004C).
 *
 * A provider-model pair only becomes eligible for automatic routing after
 * its current availability has been established through an approved
 * evidence source (an authoritative account-aware list/capability call, or
 * a bounded exact-model execution probe) — never merely because it appears
 * in a static list, an installed binary, or a previous config.json. See
 * modelCatalogRefresh.js for the discovery/validation orchestration that
 * populates this store; this module owns state, persistence, and the
 * eligibility rule itself.
 */

import fs from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), "data");
const catalogPath = path.join(dataDir, "model-catalog.json");

export const MODEL_STATES = [
  "exposed",
  "validated",
  "stale",
  "rejected",
  "unavailable",
  "authentication_blocked",
  "quota_blocked",
  "entitlement_blocked",
  "configuration_blocked",
  "provider_offline",
  "unknown",
  "retired"
];

/** Only these two states may ever grant automatic routing eligibility. */
export const AUTO_ELIGIBLE_STATES = new Set(["exposed", "validated"]);

export const FAILURE_CLASSIFICATIONS = [
  "MODEL_NOT_FOUND",
  "MODEL_REJECTED",
  "MODEL_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "QUOTA_EXHAUSTED",
  "ENTITLEMENT_REQUIRED",
  "RATE_LIMITED",
  "PROVIDER_OFFLINE",
  "CONFIGURATION_ERROR",
  "TIMEOUT",
  "TRANSIENT_FAILURE"
];

/** Failure classifications that only skip this request, not the model's catalog state — transient by nature. */
const TRANSIENT_CLASSIFICATIONS = new Set(["RATE_LIMITED", "TIMEOUT", "TRANSIENT_FAILURE"]);

const STATE_FOR_FAILURE = {
  MODEL_NOT_FOUND: "rejected",
  MODEL_REJECTED: "rejected",
  MODEL_UNAVAILABLE: "unavailable",
  AUTHENTICATION_FAILED: "authentication_blocked",
  QUOTA_EXHAUSTED: "quota_blocked",
  ENTITLEMENT_REQUIRED: "entitlement_blocked",
  CONFIGURATION_ERROR: "configuration_blocked",
  PROVIDER_OFFLINE: "provider_offline"
};

/**
 * Classifies a provider/execution error against the model-specific failure
 * taxonomy. Distinct from orchestration/errorClassification.js's
 * classifyError(), which is a coarser service-level classification used for
 * telemetry — this one exists to decide the *model's* catalog state, so it
 * recognizes invalid-model / entitlement / quota language that the coarser
 * classifier has no reason to know about.
 */
export function classifyModelFailure(error) {
  if (!error) {
    return "TRANSIENT_FAILURE";
  }
  const message = String(error.message ?? "").toLowerCase();
  // `error.stderr ?? error.stdout` was wrong here: `??` only falls through on
  // null/undefined, not on an empty string — and cli.js's runProcess always
  // sets `error.stderr = stderr` (often `""`) even when the real diagnostic
  // text came back on stdout (confirmed against the real claude CLI: an
  // invalid --model prints "There's an issue with the selected model ..."
  // to stdout with empty stderr). Concatenate both unconditionally instead.
  const detail = `${error.stderr || ""} ${error.stdout || ""}`.toLowerCase();
  const text = `${message} ${detail}`;

  if (
    /model not found|unknown model|no such model|invalid model|does not exist|may not exist|issue with the selected model/.test(
      text
    )
  ) {
    return "MODEL_NOT_FOUND";
  }
  if (/unsupported model|model not supported|model.*rejected|rejected.*model|you may not have access to it/.test(text)) {
    return "MODEL_REJECTED";
  }
  if (/model.*unavailable|temporarily unavailable|model is currently/.test(text)) {
    return "MODEL_UNAVAILABLE";
  }
  if (/unauthorized|authentication|not logged in|please (sign|log) in|401/.test(text)) {
    return "AUTHENTICATION_FAILED";
  }
  if (/quota|insufficient credit|out of credit|out of extra usage|billing/.test(text)) {
    return "QUOTA_EXHAUSTED";
  }
  if (/entitlement|not entitled|requires (a )?subscription|plan does not include|upgrade your plan/.test(text)) {
    return "ENTITLEMENT_REQUIRED";
  }
  if (/rate limit|429|too many requests/.test(text)) {
    return "RATE_LIMITED";
  }
  if (/econnrefused|enotfound|econnreset|eai_again|provider offline|service unavailable|502|503/.test(text)) {
    return "PROVIDER_OFFLINE";
  }
  if (/missing baseurl|baseurl is required|invalid configuration|configuration error/.test(text)) {
    return "CONFIGURATION_ERROR";
  }
  if (error.code === "ETIMEDOUT" || /timed out|timeout/.test(text)) {
    return "TIMEOUT";
  }
  return "TRANSIENT_FAILURE";
}

export function defaultCatalog() {
  return {
    generation: 0,
    schedule: {
      refreshing: false,
      lastRefreshStartedAt: null,
      lastRefreshCompletedAt: null,
      lastSuccessfulRefreshAt: null,
      nextRefreshAt: null
    },
    providers: {}
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Defends against a partially-written or hand-edited catalog file — never trust its shape blindly. */
export function normalizeCatalog(raw) {
  const base = defaultCatalog();
  if (!isPlainObject(raw)) {
    return base;
  }
  return {
    generation: Number.isFinite(raw.generation) ? raw.generation : 0,
    schedule: { ...base.schedule, ...(isPlainObject(raw.schedule) ? raw.schedule : {}) },
    providers: isPlainObject(raw.providers) ? raw.providers : {}
  };
}

export async function loadCatalog() {
  try {
    const raw = await fs.readFile(catalogPath, "utf8");
    return normalizeCatalog(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read model catalog, starting fresh: ${error.message}`);
    }
    return defaultCatalog();
  }
}

/** Atomic write (tmp file + rename) — a crash mid-write must never leave a truncated/corrupt catalog behind. */
export async function saveCatalog(catalog) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmpPath = `${catalogPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, catalogPath);
  return catalog;
}

function ensureProviderBucket(catalog, provider) {
  if (!catalog.providers[provider]) {
    catalog.providers[provider] = { lastDiscoveryAt: null, cliVersion: null, models: {} };
  }
  return catalog.providers[provider];
}

/**
 * True only when an entry's state is auto-eligible AND (for validated
 * entries) still inside the validation TTL. "exposed" entries are trusted
 * only through the end of the generation they were confirmed in — a
 * provider that fails discovery on a later refresh cycle leaves its old
 * "exposed" entries in the catalog (for the dashboard/history) but they
 * stop being current once currentGeneration has moved past them, which
 * refreshProviderCatalog enforces by demoting them to "stale" rather than
 * carrying the exposed state forward blindly.
 */
export function isEligibleNow(entry, { ttlHours = 24, now = Date.now() } = {}) {
  if (!entry || !AUTO_ELIGIBLE_STATES.has(entry.state)) {
    return false;
  }
  if (entry.state === "validated") {
    if (!entry.validatedAt) {
      return false;
    }
    const ageHours = (now - Date.parse(entry.validatedAt)) / 3_600_000;
    return ageHours <= ttlHours;
  }
  return true;
}

/**
 * Authoritative replacement for one provider's candidate set — never a
 * merge. Entries confirmed in this refresh get filled in as given;
 * previously-known entries absent from `nextEntries` are demoted to
 * "retired" (history preserved, excluded from routing) rather than
 * deleted, per the "preserve historical telemetry" requirement.
 */
export function replaceProviderModels(catalog, provider, nextEntries, { now = new Date().toISOString(), cliVersion = null } = {}) {
  const bucket = ensureProviderBucket(catalog, provider);
  const previousIds = new Set(Object.keys(bucket.models));
  const nextIds = new Set(nextEntries.map((e) => e.modelId));

  for (const entry of nextEntries) {
    const previous = bucket.models[entry.modelId];
    bucket.models[entry.modelId] = {
      provider,
      modelId: entry.modelId,
      displayName: entry.displayName || entry.modelId,
      isAlias: Boolean(entry.isAlias),
      state: entry.state,
      discoverySource: entry.discoverySource,
      discoveredAt: now,
      validatedAt: entry.state === "validated" ? now : (previous?.validatedAt ?? null),
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFailureAt: previous?.lastFailureAt ?? null,
      lastFailureClassification: previous?.lastFailureClassification ?? null,
      cliVersion,
      catalogGeneration: catalog.generation,
      automaticEligibility: AUTO_ELIGIBLE_STATES.has(entry.state),
      retryAt: null
    };
  }

  for (const id of previousIds) {
    if (nextIds.has(id)) {
      continue;
    }
    const entry = bucket.models[id];
    if (entry.state !== "retired") {
      bucket.models[id] = { ...entry, state: "retired", automaticEligibility: false, catalogGeneration: catalog.generation };
    }
  }

  bucket.lastDiscoveryAt = now;
  bucket.cliVersion = cliVersion;
  return catalog;
}

/**
 * Applies one execution result (success or failure) to a single
 * provider-model pair, immediately — this is what lets the very next
 * request exclude a model that just failed, without waiting for the next
 * scheduled refresh. Transient classifications (rate limit / timeout /
 * generic transient) record the failure for visibility but do not demote
 * an otherwise-eligible model's state, since a single transient blip is
 * not evidence the model itself is invalid.
 */
export function applyExecutionResult(catalog, provider, modelId, { success, classification, now = new Date().toISOString() }) {
  const bucket = ensureProviderBucket(catalog, provider);
  const existing = bucket.models[modelId] ?? {
    provider,
    modelId,
    displayName: modelId,
    isAlias: false,
    state: "unknown",
    discoverySource: "execution_probe",
    discoveredAt: now,
    validatedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureClassification: null,
    cliVersion: null,
    catalogGeneration: catalog.generation,
    automaticEligibility: false,
    retryAt: null
  };

  if (success) {
    bucket.models[modelId] = {
      ...existing,
      state: "validated",
      validatedAt: now,
      lastSuccessAt: now,
      automaticEligibility: true,
      retryAt: null
    };
    return catalog;
  }

  if (TRANSIENT_CLASSIFICATIONS.has(classification)) {
    bucket.models[modelId] = {
      ...existing,
      lastFailureAt: now,
      lastFailureClassification: classification
    };
    return catalog;
  }

  const nextState = STATE_FOR_FAILURE[classification] ?? "unknown";
  bucket.models[modelId] = {
    ...existing,
    state: nextState,
    lastFailureAt: now,
    lastFailureClassification: classification,
    automaticEligibility: false,
    retryAt: null
  };
  return catalog;
}

/** Flattened, eligibility-annotated view used by routing/modelRegistry.js and the dashboard. */
export function listCatalogEntries(catalog, provider, { ttlHours = 24, now = Date.now() } = {}) {
  const bucket = catalog.providers?.[provider];
  if (!bucket) {
    return [];
  }
  return Object.values(bucket.models).map((entry) => ({
    ...entry,
    automaticEligibility: isEligibleNow(entry, { ttlHours, now })
  }));
}

export { catalogPath, dataDir as modelCatalogDataDir };
