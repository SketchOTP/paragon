/**
 * Model-level outcome telemetry (PARAGON-D-004D, Phase 6).
 *
 * The catalog already recorded *availability* (`state`, `lastSuccessAt`,
 * `lastFailureClassification`). That answers "may I route here", not "how
 * well does this actually perform". This module adds the performance side,
 * kept logically separate from availability state even though both persist
 * under `data/routing-telemetry.json`.
 *
 * Two hard constraints:
 *  - **Bounded.** Aggregates only — counters, EWMAs and fixed-bucket
 *    histograms. No per-request history is appended, so the file cannot grow
 *    with traffic.
 *  - **No content.** Prompts, responses, credentials and provider output
 *    never enter this store. Only counts, token totals and latencies.
 */

import fs from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), "data");
const telemetryPath = path.join(dataDir, "routing-telemetry.json");

/** Fixed latency buckets (ms). Fixed-width so a histogram can never grow. */
const LATENCY_BUCKETS = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, Infinity];

/** EWMA weight for token/latency means — recent behavior dominates without storing history. */
const EWMA_ALPHA = 0.2;

export function defaultTelemetryStore() {
  return { version: 1, updatedAt: null, entries: {} };
}

/**
 * Aggregation key. Includes the execution profile so `gpt-5.6-sol-max` and
 * `gpt-5.6-sol-low` accumulate separately — the entire point of Phase 1.
 * Task dimensions are included so a model's record for trivial work does not
 * vouch for it on extreme work.
 */
export function telemetryKey({ provider, providerModelId, executionProfile = "default", workType = "unknown", complexity = "normal", contextBand = "small", outputContract = "prose" }) {
  return [provider, providerModelId, executionProfile, workType, complexity, contextBand, outputContract].join("|");
}

/** Broader key ignoring task dimensions — used as a fallback when the specific bucket is too sparse. */
export function telemetryModelKey({ provider, providerModelId, executionProfile = "default" }) {
  return [provider, providerModelId, executionProfile].join("|");
}

function emptyEntry() {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    modelSpecificFailureCount: 0,
    timeoutCount: 0,
    rateLimitCount: 0,
    structuredOutputAttemptCount: 0,
    structuredOutputSuccessCount: 0,
    firstTokenLatencyBuckets: new Array(LATENCY_BUCKETS.length).fill(0),
    completionLatencyBuckets: new Array(LATENCY_BUCKETS.length).fill(0),
    observedInputTokens: null,
    observedVisibleOutputTokens: null,
    observedReasoningTokens: null,
    observedTotalBilledTokens: null,
    observedMonetaryCost: null,
    averageQuotaBurn: null,
    // Usage-evidence provenance (PARAGON-D-004E, Phase 1).
    usageSource: null,
    usageConfidence: null,
    usageObservationCount: 0,
    usageUnknownCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    sampleCount: 0
  };
}

/**
 * PARAGON-D-004E: `next` must be pre-filtered through numberOrNull(). Passing
 * a raw `Number(undefined_field)` here was a real defect — `Number(null)` is
 * `0`, which is finite, so a provider that reported no usage had zeros averaged
 * into its observed-token means. That made unknown usage look like free usage,
 * which is exactly what the activation gate forbids.
 */
function ewma(previous, next) {
  if (next == null || !Number.isFinite(next)) return previous;
  if (previous == null || !Number.isFinite(previous)) return next;
  return previous * (1 - EWMA_ALPHA) + next * EWMA_ALPHA;
}

/** null for absent/non-numeric, so absence is never coerced to zero. */
function numberOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bucketIndex(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  for (let i = 0; i < LATENCY_BUCKETS.length; i += 1) {
    if (value <= LATENCY_BUCKETS[i]) return i;
  }
  return LATENCY_BUCKETS.length - 1;
}

/** Interpolated percentile from the fixed buckets. Coarse by construction, and honest about it. */
function percentileFromBuckets(buckets, percentile) {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = total * percentile;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    cumulative += buckets[i];
    if (cumulative >= target) {
      const upper = LATENCY_BUCKETS[i];
      return Number.isFinite(upper) ? upper : LATENCY_BUCKETS[LATENCY_BUCKETS.length - 2];
    }
  }
  return null;
}

/**
 * Records one completed attempt.
 *
 * @param {object} store
 * @param {object} observation
 * @param {string} observation.provider
 * @param {string} observation.providerModelId
 * @param {string} [observation.executionProfile]
 * @param {object} [observation.taskProfile]
 * @param {boolean} observation.success
 * @param {string} [observation.failureClassification]
 * @param {number} [observation.firstTokenLatencyMs]
 * @param {number} [observation.completionLatencyMs]
 * @param {object} [observation.usage] - { inputTokens, visibleOutputTokens, reasoningTokens, totalBilledTokens }
 * @param {number} [observation.quotaBurn]
 * @param {boolean} [observation.structuredOutputRequired]
 * @param {boolean} [observation.structuredOutputValid]
 */
export function recordOutcome(store, observation) {
  const now = observation.now ?? new Date().toISOString();
  const task = observation.taskProfile ?? {};
  const keys = [
    telemetryKey({
      provider: observation.provider,
      providerModelId: observation.providerModelId,
      executionProfile: observation.executionProfile,
      workType: task.workType,
      complexity: task.complexity,
      contextBand: task.contextBand,
      outputContract: task.outputContract
    }),
    telemetryModelKey({
      provider: observation.provider,
      providerModelId: observation.providerModelId,
      executionProfile: observation.executionProfile
    })
  ];

  for (const key of keys) {
    const entry = store.entries[key] ?? emptyEntry();

    entry.requestCount += 1;
    entry.sampleCount += 1;
    if (observation.success) {
      entry.successCount += 1;
      entry.lastSuccessAt = now;
    } else {
      entry.failureCount += 1;
      entry.lastFailureAt = now;
      const c = observation.failureClassification;
      if (c === "TIMEOUT") entry.timeoutCount += 1;
      else if (c === "RATE_LIMITED") entry.rateLimitCount += 1;
      else if (c === "MODEL_NOT_FOUND" || c === "MODEL_REJECTED" || c === "MODEL_UNAVAILABLE") entry.modelSpecificFailureCount += 1;
    }

    if (observation.structuredOutputRequired) {
      entry.structuredOutputAttemptCount += 1;
      if (observation.structuredOutputValid) entry.structuredOutputSuccessCount += 1;
    }

    const ftl = bucketIndex(observation.firstTokenLatencyMs);
    if (ftl != null) entry.firstTokenLatencyBuckets[ftl] += 1;
    const cl = bucketIndex(observation.completionLatencyMs);
    if (cl != null) entry.completionLatencyBuckets[cl] += 1;

    const usage = observation.usage ?? {};
    entry.observedInputTokens = ewma(entry.observedInputTokens, numberOrNull(usage.inputTokens));
    entry.observedVisibleOutputTokens = ewma(entry.observedVisibleOutputTokens, numberOrNull(usage.visibleOutputTokens));
    entry.observedReasoningTokens = ewma(entry.observedReasoningTokens, numberOrNull(usage.reasoningTokens));
    entry.observedTotalBilledTokens = ewma(entry.observedTotalBilledTokens, numberOrNull(usage.totalBilledTokens));
    entry.observedMonetaryCost = ewma(entry.observedMonetaryCost, numberOrNull(usage.monetaryCost));
    entry.averageQuotaBurn = ewma(entry.averageQuotaBurn, numberOrNull(observation.quotaBurn));

    // Provenance of the token accounting above, so the scorer and Diagnostics
    // can distinguish "measured" from "never reported" instead of inferring it
    // from a zero.
    if (usage.usageSource && usage.usageSource !== "unknown") {
      entry.usageSource = usage.usageSource;
      entry.usageConfidence = usage.usageConfidence ?? null;
      entry.usageObservationCount = (entry.usageObservationCount ?? 0) + 1;
    } else {
      entry.usageUnknownCount = (entry.usageUnknownCount ?? 0) + 1;
    }

    store.entries[key] = entry;
  }

  store.updatedAt = now;
  return store;
}

/**
 * Reads a usable estimate for a candidate, preferring the task-specific
 * bucket and falling back to the model-wide bucket when the specific one is
 * too sparse to trust.
 *
 * Success probability uses **Laplace smoothing** toward a neutral prior, so
 * one lucky request cannot outrank a model with hundreds of stable ones:
 * a 1/1 model reports ~0.67, not 1.0.
 */
export function readTelemetry(store, selector, { minimumSamplesForMeasuredEstimate = 10, priorSuccessWeight = 4 } = {}) {
  const specificKey = telemetryKey(selector);
  const modelKey = telemetryModelKey(selector);
  const specific = store?.entries?.[specificKey];
  const wide = store?.entries?.[modelKey];

  const chosen = specific && specific.sampleCount >= minimumSamplesForMeasuredEstimate ? specific : wide ?? specific;
  if (!chosen) {
    return {
      sampleCount: 0,
      measurementConfidence: "none",
      successRate: null,
      smoothedSuccessProbability: null,
      failureRate: null,
      source: "no_evidence"
    };
  }

  const n = chosen.requestCount;
  const successRate = n > 0 ? chosen.successCount / n : null;
  // Beta-style shrinkage toward 0.5.
  const smoothed = (chosen.successCount + priorSuccessWeight * 0.5) / (n + priorSuccessWeight);

  const structuredAttempts = chosen.structuredOutputAttemptCount;
  return {
    sampleCount: chosen.sampleCount,
    measurementConfidence:
      chosen.sampleCount >= minimumSamplesForMeasuredEstimate * 5
        ? "high"
        : chosen.sampleCount >= minimumSamplesForMeasuredEstimate
          ? "medium"
          : chosen.sampleCount > 0
            ? "low"
            : "none",
    successRate,
    smoothedSuccessProbability: smoothed,
    failureRate: n > 0 ? chosen.failureCount / n : null,
    modelSpecificFailureRate: n > 0 ? chosen.modelSpecificFailureCount / n : null,
    timeoutRate: n > 0 ? chosen.timeoutCount / n : null,
    rateLimitRate: n > 0 ? chosen.rateLimitCount / n : null,
    jsonComplianceRate: structuredAttempts > 0 ? chosen.structuredOutputSuccessCount / structuredAttempts : null,
    firstTokenLatencyP50: percentileFromBuckets(chosen.firstTokenLatencyBuckets, 0.5),
    firstTokenLatencyP95: percentileFromBuckets(chosen.firstTokenLatencyBuckets, 0.95),
    completionLatencyP50: percentileFromBuckets(chosen.completionLatencyBuckets, 0.5),
    completionLatencyP95: percentileFromBuckets(chosen.completionLatencyBuckets, 0.95),
    observedInputTokens: chosen.observedInputTokens,
    observedVisibleOutputTokens: chosen.observedVisibleOutputTokens,
    observedReasoningTokens: chosen.observedReasoningTokens,
    observedTotalBilledTokens: chosen.observedTotalBilledTokens,
    observedMonetaryCost: chosen.observedMonetaryCost ?? null,
    averageQuotaBurn: chosen.averageQuotaBurn,
    usageSource: chosen.usageSource ?? null,
    usageConfidence: chosen.usageConfidence ?? null,
    usageObservationCount: chosen.usageObservationCount ?? 0,
    usageUnknownCount: chosen.usageUnknownCount ?? 0,
    lastSuccessAt: chosen.lastSuccessAt,
    lastFailureAt: chosen.lastFailureAt,
    source: chosen === specific ? "task_specific" : "model_wide"
  };
}

/** Drops entries with no activity inside the retention window. Keeps the store bounded over time as well as per-request. */
export function pruneTelemetry(store, { retentionDays = 30, now = Date.now() } = {}) {
  const cutoff = now - retentionDays * 24 * 3_600_000;
  let removed = 0;
  for (const [key, entry] of Object.entries(store.entries ?? {})) {
    const last = Math.max(entry.lastSuccessAt ? Date.parse(entry.lastSuccessAt) : 0, entry.lastFailureAt ? Date.parse(entry.lastFailureAt) : 0);
    if (last && last < cutoff) {
      delete store.entries[key];
      removed += 1;
    }
  }
  return { removed };
}

export async function loadTelemetry() {
  try {
    const raw = await fs.readFile(telemetryPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      updatedAt: parsed.updatedAt ?? null,
      entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {}
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`routing telemetry: could not read store, starting fresh: ${error.message}`);
    }
    return defaultTelemetryStore();
  }
}

/** Atomic write — a crash mid-write must never truncate the store. */
export async function saveTelemetry(store) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${telemetryPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tmp, telemetryPath);
  return store;
}

export { telemetryPath };
