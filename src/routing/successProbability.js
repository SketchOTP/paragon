import { sufficiencyThreshold } from "./sufficiencyPolicy.js";

const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));

/** Wilson lower bound is conservative for sparse exact-tuple observations. */
export function confidenceAdjustedProbability({ successProbability, successes = 0, attempts = 0, confidence = 0.9, prior = 0.85 } = {}) {
  const n = Math.max(0, Number(attempts) || 0);
  const p = clamp(successProbability ?? (n ? successes / n : prior));
  if (!n) return clamp(p - (1 - confidence) * 0.15);
  const z = confidence >= 0.95 ? 1.96 : 1.645;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom;
  return clamp(center - margin);
}

export function estimateSuccessProbability({ taskProfile, exact = {}, production = {}, profile = {}, external = {}, prior = 0.85 } = {}) {
  const observations = [exact, production, profile].find((e) => Number(e.attempts) > 0) ?? null;
  const raw = observations ? Number(observations.successes) / Number(observations.attempts) : Number(external.taskRelevantScore ?? prior);
  const lower = confidenceAdjustedProbability({ successProbability: raw, successes: observations?.successes, attempts: observations?.attempts, prior });
  return { pointEstimate: clamp(raw), confidenceAdjusted: lower, threshold: sufficiencyThreshold(taskProfile), sufficient: lower >= sufficiencyThreshold(taskProfile), source: observations ? (observations === exact ? "exact_tuple" : observations === production ? "production" : "profile") : external.taskRelevantScore != null ? "external" : "prior" };
}
