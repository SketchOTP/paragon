/**
 * Published model pricing used by the live router.
 *
 * A route is not eligible merely because a provider exposes a model. It must
 * also have an attributable, dated price. Subscription/allowance wording is
 * deliberately not a pricing value: Codex credits and provider API prices are
 * recorded in their actual published billing units.
 */

export const PRICING_CATALOG_AS_OF = "2026-07-30";

const OPENAI_API = "https://developers.openai.com/api/docs/models/compare";
const CODEX_RATE_CARD = "https://help.openai.com/en/articles/20001106-codex-rate-card";
const ANTHROPIC_PRICING = "https://docs.anthropic.com/en/docs/about-claude/pricing";
const GOOGLE_PRICING = "https://ai.google.dev/gemini-api/docs/pricing";

const USD = (input, output, cachedInput, sourceUrl) => ({
  billingUnit: "USD per 1M tokens",
  inputPerMillion: input,
  completionPerMillion: output,
  cacheReadPerMillion: cachedInput,
  confidence: "official",
  sourceUrl,
  asOf: PRICING_CATALOG_AS_OF
});

const CREDITS = (input, output, cachedInput, apiInput, apiOutput, apiCachedInput) => ({
  billingUnit: "Codex credits per 1M tokens",
  inputPerMillion: input,
  completionPerMillion: output,
  cacheReadPerMillion: cachedInput,
  source: "OpenAI Codex rate card",
  confidence: "official",
  sourceUrl: CODEX_RATE_CARD,
  asOf: PRICING_CATALOG_AS_OF,
  ...(apiInput != null && apiOutput != null
    ? {
        apiPricing: {
          billingUnit: "USD per 1M tokens",
          inputPerMillion: apiInput,
          completionPerMillion: apiOutput,
          cacheReadPerMillion: apiCachedInput,
          confidence: "official",
          source: "OpenAI API model pricing",
          sourceUrl: OPENAI_API,
          asOf: PRICING_CATALOG_AS_OF
        }
      }
    : {})
});

const CODEX_PRICES = [
  [/^gpt-5\.6-luna(?:$|[-.])/i, CREDITS(5, 30, 0.5, 0.2, 1.2, 0.02)],
  [/^gpt-5\.6-terra(?:$|[-.])/i, CREDITS(50, 300, 5, 2, 12, 0.2)],
  [/^gpt-5\.6-sol(?:$|[-.])/i, CREDITS(125, 750, 12.5, 5, 30, 0.5)],
  [/^gpt-5\.5(?:$|[-.])/i, CREDITS(125, 750, 12.5)],
  [/^gpt-5\.4-mini(?:$|[-.])/i, CREDITS(18.75, 113, 1.875, 0.75, 4.5, 0.075)],
  [/^gpt-5\.4(?:$|[-.])/i, CREDITS(62.5, 375, 6.25, 2.5, 15, 0.25)],
  [/^gpt-5\.(?:3-codex|2)(?:$|[-.])/i, CREDITS(43.75, 350, 4.375)]
];

const CLAUDE_PRICES = [
  [/fable-5/i, USD(10, 50, 1, ANTHROPIC_PRICING)],
  [/mythos-5/i, USD(10, 50, 1, ANTHROPIC_PRICING)],
  [/opus-(?:5|4\.[5-8])/i, USD(5, 25, 0.5, ANTHROPIC_PRICING)],
  [/opus-4\.[01]/i, USD(15, 75, 1.5, ANTHROPIC_PRICING)],
  [/sonnet-5/i, USD(2, 10, 0.2, ANTHROPIC_PRICING)],
  [/sonnet-4(?:\.[5-6])?/i, USD(3, 15, 0.3, ANTHROPIC_PRICING)],
  [/haiku-4\.5/i, USD(1, 5, 0.1, ANTHROPIC_PRICING)],
  [/haiku-3\.5/i, USD(0.8, 4, 0.08, ANTHROPIC_PRICING)]
];

const GEMINI_PRICES = [
  [/gemini-3\.1-pro/i, USD(2.7, 16.2, 0.27, GOOGLE_PRICING)],
  [/gemini-3\.1-flash-lite/i, USD(0.25, 1.5, 0.025, GOOGLE_PRICING)],
  [/gemini-3\.5-flash-lite/i, USD(0.3, 2.5, 0.03, GOOGLE_PRICING)],
  [/gemini-2\.5-pro/i, USD(1.25, 10, 0.3125, GOOGLE_PRICING)],
  [/gemini-2\.5-flash/i, USD(0.3, 2.5, 0.03, GOOGLE_PRICING)]
];

function lookup(patterns, modelId) {
  const match = patterns.find(([pattern]) => pattern.test(modelId));
  return match ? { ...match[1] } : null;
}

/**
 * Resolve provider-owned pricing. Benchmark rows can describe quality for
 * every provider, but their prices belong exclusively to OpenRouter tuples.
 */
export function publishedModelPricing({ provider, modelId, benchmarkPricing = null, metadata = null } = {}) {
  const id = String(modelId ?? "");
  if (provider === "codex") {
    return lookup(CODEX_PRICES, id);
  }
  if (provider === "claude") {
    return lookup(CLAUDE_PRICES, id);
  }
  if (provider === "antigravity") {
    return lookup(GEMINI_PRICES, id);
  }
  if (provider !== "openrouter" && metadata?.pricing?.prompt != null && metadata?.pricing?.completion != null) {
    return {
      ...metadata.pricing,
      source: metadata.pricing.source ?? "provider metadata",
      asOf: metadata.pricing.asOf ?? PRICING_CATALOG_AS_OF
    };
  }
  if (provider === "openrouter" && benchmarkPricing?.prompt != null && benchmarkPricing?.completion != null) {
    const prompt = Number(benchmarkPricing.prompt);
    const completion = Number(benchmarkPricing.completion ?? benchmarkPricing.prompt);
    return {
      billingUnit: "USD per token",
      prompt,
      completion,
      inputPerMillion: prompt * 1_000_000,
      completionPerMillion: completion * 1_000_000,
      source: "OpenRouter benchmark pricing",
      confidence: "benchmark",
      sourceUrl: "https://openrouter.ai/api/v1/benchmarks",
      asOf: PRICING_CATALOG_AS_OF
    };
  }
  return null;
}
