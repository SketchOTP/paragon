import { applyPricingValidation } from "./pricingValidation.js";

const AUTHORITY_RANK = {
  manual_override: 100,
  official_pricing: 90,
  account_api: 80,
  aggregator_pricing: 50,
  aggregator_hint: 30,
  static_official_table: 40,
  subscription_estimate: 10,
  unknown: 0
};

/**
 * Merge pricing records with authority priority and route_context rules.
 */
export function crossValidatePricing(records, previousEvidence = {}, options = {}) {
  const largeChangePct = options.largePriceChangePercent ?? 25;
  const byCanonical = new Map();
  const priceChanges = [];
  const requiresReview = [];
  const invalid = [];

  for (const row of records) {
    const validated = applyPricingValidation(row);
    const record = {
      ...row,
      ...validated,
      pricing_source: row.source_authority ?? row.pricing_source
    };

    if (record.pricing_status === "invalid") {
      invalid.push(record);
      continue;
    }

    // OpenRouter pricing only applies to aggregator routes.
    if (record.source_authority === "aggregator_pricing" && record.route_context !== "aggregator") {
      record.route_context = "aggregator";
      record.canonical_id = record.canonical_id.startsWith("openrouter:")
        ? record.canonical_id
        : `openrouter:${record.model}`;
    }

    const key = record.canonical_id;
    const prev = byCanonical.get(key);
    const rank = AUTHORITY_RANK[record.source_authority] ?? 0;
    const prevRank = prev ? AUTHORITY_RANK[prev.source_authority] ?? 0 : -1;

    if (!prev || rank > prevRank || (rank === prevRank && (record.confidence ?? 0) > (prev.confidence ?? 0))) {
      if (prev && prev.route_context !== record.route_context) {
        record.alternate_prices = [...(prev.alternate_prices ?? []), summarizeAlt(prev)];
      }
      byCanonical.set(key, record);
    } else if (prev) {
      prev.alternate_prices = [...(prev.alternate_prices ?? []), summarizeAlt(record)];
      byCanonical.set(key, prev);
    }
  }

  const pricing = [];
  for (const [canonicalId, record] of byCanonical) {
    const prior = previousEvidence[canonicalId];
    if (prior?.input_per_1m != null && record.input_per_1m != null && prior.input_per_1m > 0) {
      const delta = (record.input_per_1m - prior.input_per_1m) / prior.input_per_1m;
      if (Math.abs(delta) >= 0.01) {
        const change = {
          canonical_id: canonicalId,
          field: "input_per_1m",
          old: prior.input_per_1m,
          new: record.input_per_1m,
          delta_pct: Math.round(delta * 10000) / 100,
          source_authority: record.source_authority
        };
        priceChanges.push(change);
        if (Math.abs(delta) * 100 >= largeChangePct && record.source_authority !== "official_pricing") {
          record.requires_review = true;
          requiresReview.push(change);
        }
      }
    }

    pricing.push({
      ...record,
      cost_sensitive_eligible:
        record.pricing_status === "valid" &&
        record.route_context !== "subscription" &&
        Boolean(record.source_url || record.source_authority === "manual_override")
    });
  }

  return { pricing, priceChanges, requiresReview, invalid };
}

function summarizeAlt(row) {
  return {
    route_context: row.route_context,
    input_per_1m: row.input_per_1m,
    output_per_1m: row.output_per_1m,
    source_url: row.source_url,
    source_authority: row.source_authority,
    source_hash: row.source_hash
  };
}

export function pickPricingForRoute(record, routeContext) {
  if (!record) return null;
  if (record.route_context === routeContext) return record;
  const alt = (record.alternate_prices ?? []).find((a) => a.route_context === routeContext);
  if (alt) {
    return { ...record, ...alt, route_context: routeContext };
  }
  // Direct provider must not use aggregator as billing truth
  if (routeContext === "direct_provider" && record.route_context === "aggregator") {
    return null;
  }
  return record;
}
