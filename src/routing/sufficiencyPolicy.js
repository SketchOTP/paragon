import { SUFFICIENCY_RISK_THRESHOLDS } from "./taskProfileV2.js";

export function sufficiencyThreshold(taskProfile = {}) {
  const byComplexity = { trivial: 0.78, normal: 0.86, complex: 0.91, extreme: 0.94 };
  const risk = SUFFICIENCY_RISK_THRESHOLDS[taskProfile.risk];
  const complexity = byComplexity[taskProfile.complexity];
  const policyValues = [risk, complexity].filter((value) => value != null);
  return Number(taskProfile.sufficiencyThreshold ?? (policyValues.length ? Math.max(...policyValues) : SUFFICIENCY_RISK_RISK_DEFAULT));
}

const SUFFICIENCY_RISK_RISK_DEFAULT = SUFFICIENCY_RISK_THRESHOLDS.normal;

export function applySufficiencyPolicy(probability, taskProfile, { confidenceAdjusted = null } = {}) {
  const estimate = Number(confidenceAdjusted ?? probability);
  const threshold = sufficiencyThreshold(taskProfile);
  return { threshold, probability: estimate, sufficient: estimate >= threshold, route: estimate >= threshold ? "satisfactory" : "degraded_sufficiency" };
}
