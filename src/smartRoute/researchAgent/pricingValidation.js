/**
 * Hard validation for pricing numbers used in cost-sensitive routing.
 */

const SENTINEL_ABS = 100_000;
const MAX_REASONABLE_PER_1M = 10_000;

/**
 * @returns {{ ok: boolean, reason: string|null, status: "valid"|"invalid"|"unknown" }}
 */
export function validatePricingNumbers(pricing = {}) {
  const input = pricing.input_per_1m;
  const output = pricing.output_per_1m;

  if (input == null && output == null) {
    return { ok: false, reason: "unknown", status: "unknown" };
  }

  for (const [field, value] of [
    ["input_per_1m", input],
    ["output_per_1m", output],
    ["cached_input_per_1m", pricing.cached_input_per_1m],
    ["batch_input_per_1m", pricing.batch_input_per_1m],
    ["batch_output_per_1m", pricing.batch_output_per_1m]
  ]) {
    if (value == null) continue;
    const num = Number(value);
    if (Number.isNaN(num)) {
      return { ok: false, reason: "nan", status: "invalid" };
    }
    if (!Number.isFinite(num)) {
      return { ok: false, reason: "infinity", status: "invalid" };
    }
    if (num < 0) {
      return { ok: false, reason: "negative_price", status: "invalid" };
    }
    if (Math.abs(num) >= SENTINEL_ABS) {
      return { ok: false, reason: "sentinel_value", status: "invalid" };
    }
    if (num > MAX_REASONABLE_PER_1M) {
      return { ok: false, reason: "absurd_price", status: "invalid" };
    }
  }

  const billing = pricing.billing_model ?? "unknown";
  const allowZero =
    billing === "local" ||
    billing === "subscription" ||
    pricing.pricing_source === "manual" ||
    pricing.explicit_free === true;

  if ((input === 0 || output === 0) && !allowZero) {
    return { ok: false, reason: "zero_price_without_free_context", status: "invalid" };
  }

  if (input == null || output == null) {
    return { ok: false, reason: "missing_unit", status: "invalid" };
  }

  return { ok: true, reason: null, status: "valid" };
}

export function applyPricingValidation(pricing) {
  if (!pricing || typeof pricing !== "object") {
    return {
      pricing_source: "unknown",
      pricing_status: "unknown",
      pricing_invalid_reason: "unknown",
      input_per_1m: null,
      output_per_1m: null,
      pricing_confidence: 0
    };
  }

  const check = validatePricingNumbers(pricing);
  if (check.ok) {
    return {
      ...pricing,
      pricing_status: "valid",
      pricing_invalid_reason: null
    };
  }

  return {
    ...pricing,
    pricing_status: check.status,
    pricing_invalid_reason: check.reason,
    pricing_confidence: 0,
    // Keep numbers for diagnostics but mark unusable for routing
    input_per_1m: pricing.input_per_1m,
    output_per_1m: pricing.output_per_1m
  };
}

export function hasTraceableValidPricing(pricing) {
  if (!pricing) return false;
  if (pricing.pricing_status === "invalid" || pricing.pricing_status === "unknown") {
    return false;
  }
  if (pricing.pricing_source === "unknown") return false;
  if (pricing.pricing_invalid_reason) return false;
  const check = validatePricingNumbers(pricing);
  return check.ok;
}
