/**
 * Benchmark canonicalization (PARAGON-D-004D, Phase 7).
 *
 * PARAGON-D-004C1 made matching equality-only, which was correct but cut
 * coverage from 227 to 48 models — because 179 of those matches had been
 * substring collisions against *decorated* provider ids. Most of the loss is
 * recoverable legitimately: `gpt-5.6-sol-max` never had a benchmark row of
 * its own, but its canonical base model `gpt-5.6-sol` does.
 *
 * So matching now runs against the **canonical** model id produced by
 * Phase 1's provider-specific parser, not the decorated provider id. That is
 * a different mechanism from the old substring guessing: the execution
 * modifiers are removed by a declared per-provider grammar, and the
 * remaining comparison is still strict equality.
 *
 * Critically, a benchmark describes the *base model's general quality*. It
 * says nothing about what a `max` reasoning profile costs, how long it takes,
 * or whether it is better for a given task. Those come from the cost model
 * and from measured outcomes, which override base priors as evidence
 * accumulates.
 */

import { matchBenchmarkRow, canonicalModelKey } from "./benchmarks.js";

export const MATCH_METHODS = ["exact", "exact_normalized", "canonical_model", "explicit_alias", "none"];

/**
 * Validates and normalizes an operator alias record. Every field the
 * directive requires is mandatory, and a record missing provenance is
 * rejected rather than silently accepted — an alias asserts model identity,
 * so an unreviewed one is worse than no alias.
 */
export function normalizeAliasRecord(record) {
  const required = ["providerModelId", "canonicalModelId", "benchmarkModelId", "rationale", "reviewedAt", "source"];
  const missing = required.filter((field) => !record?.[field]);
  if (missing.length) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    record: {
      providerModelId: String(record.providerModelId),
      canonicalModelId: String(record.canonicalModelId),
      benchmarkModelId: String(record.benchmarkModelId),
      rationale: String(record.rationale),
      reviewedAt: String(record.reviewedAt),
      source: String(record.source),
      enabled: record.enabled !== false
    }
  };
}

export function buildAliasIndex(aliasMappings = []) {
  const index = new Map();
  const rejected = [];
  for (const raw of aliasMappings) {
    const normalized = normalizeAliasRecord(raw);
    if (!normalized.ok) {
      rejected.push({ record: raw, missing: normalized.missing });
      continue;
    }
    if (!normalized.record.enabled) {
      continue;
    }
    index.set(normalized.record.providerModelId, normalized.record);
  }
  return { index, rejected };
}

/**
 * Resolves benchmark evidence for one candidate.
 *
 * Order:
 *   1. explicit reviewed alias for the exact provider model id
 *   2. equality match on the provider model id itself (D-004C1 behavior)
 *   3. equality match on the Phase 1 canonical model id
 *
 * Never substring, never family inference. Returns `matchMethod: "none"`
 * rather than a guess.
 */
export function resolveBenchmark({ providerModelId, canonicalModelId, benchmarkRows = [], aliasIndex = new Map() }) {
  const alias = aliasIndex.get(String(providerModelId));
  if (alias) {
    const target = canonicalModelKey(alias.benchmarkModelId);
    const row = (benchmarkRows ?? []).find((r) =>
      [r.model_permaslug, r.display_name].filter(Boolean).map(canonicalModelKey).includes(target)
    );
    if (row) {
      return {
        row,
        matchMethod: "explicit_alias",
        matchConfidence: "high",
        matchedLocalModel: providerModelId,
        matchedBenchmarkModel: row.model_permaslug || row.display_name,
        aliasRationale: alias.rationale,
        appliesToCanonicalModel: alias.canonicalModelId
      };
    }
  }

  // Direct match on the decorated provider id (rare — a provider id that is
  // itself a canonical benchmark id).
  const direct = matchBenchmarkRow(providerModelId, benchmarkRows);
  if (direct) {
    return {
      ...direct,
      matchedLocalModel: providerModelId,
      matchedBenchmarkModel: direct.row.model_permaslug || direct.row.display_name,
      appliesToCanonicalModel: canonicalModelId
    };
  }

  // Match on the canonical base model, with the execution profile stripped
  // by the provider's declared grammar.
  if (canonicalModelId && canonicalModelId !== providerModelId) {
    const viaCanonical = matchBenchmarkRow(canonicalModelId, benchmarkRows);
    if (viaCanonical) {
      return {
        row: viaCanonical.row,
        // Reported distinctly so it is always visible that the score
        // describes the base model, not this execution profile.
        matchMethod: "canonical_model",
        matchConfidence: "high",
        matchedLocalModel: canonicalModelId,
        matchedBenchmarkModel: viaCanonical.row.model_permaslug || viaCanonical.row.display_name,
        appliesToCanonicalModel: canonicalModelId,
        note: "benchmark describes the canonical base model; execution profile cost/latency/quality is not implied"
      };
    }
  }

  return { row: null, matchMethod: "none", matchConfidence: "none", matchedLocalModel: providerModelId, matchedBenchmarkModel: null };
}

/** Coverage report for the evidence document and dashboard. */
export function benchmarkCoverageReport(resolutions) {
  const report = { exact: 0, exact_normalized: 0, canonical_model: 0, explicit_alias: 0, none: 0, total: 0 };
  for (const resolution of resolutions) {
    report.total += 1;
    const method = resolution?.matchMethod ?? "none";
    if (method in report) report[method] += 1;
  }
  report.matched = report.total - report.none;
  return report;
}
