/**
 * Real usage evidence capture (PARAGON-D-004E, Phase 1).
 *
 * The routing scorer needs to know what a request actually consumed, not what
 * an ordinal prior guessed it would. This module is the single place that
 * turns a provider's own response into the seven fields the cost model and
 * telemetry store consume:
 *
 *   inputTokens, visibleOutputTokens, reasoningTokens,
 *   totalBilledTokens, monetaryCost, usageSource, usageConfidence
 *
 * Hard rule: **nothing here fabricates usage.** A field the provider did not
 * report stays `null` and the record is labeled `unknown`. Downstream
 * (costModel.js) treats unknown as expensive-and-uncertain, never as zero —
 * assuming zero is exactly the bias that made max-reasoning models look cheap
 * and subscription providers look free.
 *
 * Evidence order is the directive's, most authoritative first:
 *   1. OpenAI-compatible HTTP response usage
 *   2. provider CLI structured output
 *   3. provider CLI diagnostic / metadata output
 *   4. provider account or usage endpoint
 *   5. measured bounded estimate
 *   6. unknown
 */

/** Ordered most-authoritative first; index doubles as the precedence rank. */
export const USAGE_SOURCES = [
  "http_response_usage",
  "provider_cli_structured",
  "provider_cli_diagnostic",
  "provider_account_endpoint",
  "measured_bounded_estimate",
  "unknown"
];

export const USAGE_CONFIDENCES = ["high", "medium", "low", "none"];

export function usageSourceRank(source) {
  const index = USAGE_SOURCES.indexOf(source);
  return index === -1 ? USAGE_SOURCES.length : index;
}

/**
 * null for anything that is not a real non-negative number.
 *
 * The explicit `value == null` guard is load-bearing: `Number(null)` is `0`,
 * which is finite and non-negative, so without it an absent field would be
 * reported as *zero usage* rather than *unknown usage* — the precise
 * unknown-is-free bias the activation gate forbids. Caught by a live
 * end-to-end request whose provider reported no usage and which nonetheless
 * emitted `reasoning_tokens: 0`.
 */
function positiveNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sumDefined(...values) {
  const present = values.map(positiveNumber).filter((v) => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/**
 * The canonical shape. Every producer in this file returns exactly this, so a
 * consumer never has to know which provider it came from.
 */
export function normalizeUsage({
  inputTokens = null,
  visibleOutputTokens = null,
  reasoningTokens = null,
  totalBilledTokens = null,
  monetaryCost = null,
  usageSource = "unknown",
  usageConfidence = "none",
  detail = null
} = {}) {
  const input = positiveNumber(inputTokens);
  const visible = positiveNumber(visibleOutputTokens);
  const reasoning = positiveNumber(reasoningTokens);
  const reportedTotal = positiveNumber(totalBilledTokens);
  // Derive a total only from parts the provider actually reported. A derived
  // total is still real evidence; it is not an estimate.
  const total = reportedTotal ?? sumDefined(input, visible, reasoning);

  const known = [input, visible, reasoning, total].some((v) => v != null) || positiveNumber(monetaryCost) != null;
  const source = known ? usageSource : "unknown";

  return {
    inputTokens: input,
    visibleOutputTokens: visible,
    reasoningTokens: reasoning,
    totalBilledTokens: total,
    monetaryCost: positiveNumber(monetaryCost),
    usageSource: source,
    usageConfidence: known ? usageConfidence : "none",
    // True when the provider gave us no token accounting at all. Consumers
    // must apply an uncertainty penalty rather than assuming zero cost.
    usageUnknown: !known,
    detail
  };
}

/** No evidence at all. Explicit rather than an empty object, so it is never mistaken for zero usage. */
export function unknownUsage(detail = null) {
  return normalizeUsage({ usageSource: "unknown", usageConfidence: "none", detail });
}

/**
 * OpenAI-compatible `usage` block (evidence source 1).
 *
 * Handles the reasoning-token split correctly: OpenAI reports
 * `completion_tokens` as the *total* completion including reasoning, with the
 * reasoning portion broken out under `completion_tokens_details`. Reporting
 * both at face value would double-count, so visible output is the remainder.
 */
export function extractOpenAiUsage(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") {
    return unknownUsage("no usage block in HTTP response");
  }

  const input = positiveNumber(usage.prompt_tokens ?? usage.input_tokens);
  const completion = positiveNumber(usage.completion_tokens ?? usage.output_tokens);
  const reasoning = positiveNumber(
    usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens
  );

  let visible = completion;
  if (completion != null && reasoning != null) {
    // Guard against a provider that reports them as disjoint already.
    visible = completion >= reasoning ? completion - reasoning : completion;
  }

  return normalizeUsage({
    inputTokens: input,
    visibleOutputTokens: visible,
    reasoningTokens: reasoning,
    totalBilledTokens: usage.total_tokens,
    // Some OpenAI-compatible gateways (OpenRouter et al.) return real cost.
    monetaryCost: usage.cost ?? usage.total_cost ?? usage.cost_usd,
    usageSource: "http_response_usage",
    usageConfidence: "high"
  });
}

/**
 * Claude Code CLI `--output-format json` (evidence source 2).
 *
 * Verified against the installed CLI rather than assumed. Shape:
 *   { result, total_cost_usd, usage: { input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens, ... } }
 *
 * Cache-read and cache-creation input tokens are real billed input and are
 * summed into inputTokens. Claude does not break reasoning out of
 * `output_tokens`, so reasoningTokens stays null (unknown) rather than being
 * invented or assumed zero.
 */
export function extractClaudeCliUsage(parsed) {
  const usage = parsed?.usage;
  if (!usage || typeof usage !== "object") {
    return unknownUsage("no usage block in claude JSON output");
  }
  const input = sumDefined(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
  const output = positiveNumber(usage.output_tokens);
  return normalizeUsage({
    inputTokens: input,
    visibleOutputTokens: output,
    // Folded into output_tokens by this CLI — genuinely unknown, not zero.
    reasoningTokens: null,
    totalBilledTokens: sumDefined(input, output),
    monetaryCost: parsed.total_cost_usd ?? parsed.cost_usd,
    usageSource: "provider_cli_structured",
    usageConfidence: "high",
    detail: "claude --output-format json"
  });
}

/**
 * Generic structured-CLI usage (evidence source 2/3).
 *
 * Scans a CLI's stdout for JSON — either one object or JSONL event stream —
 * and returns usage from the last object that carries a recognizable usage
 * block. Deliberately permissive about key naming (`input_tokens` /
 * `prompt_tokens` / `inputTokens`) because every CLI spells it differently,
 * and deliberately silent when nothing matches: an unparsed stdout yields
 * `unknown`, never a guess.
 */
export function extractStructuredCliUsage(stdout) {
  const objects = parseJsonObjects(stdout);
  if (!objects.length) {
    return unknownUsage("CLI output is not structured JSON");
  }

  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = objects[i];
    // Claude's shape is distinctive enough to route to its exact reader.
    if (object?.usage && (object.total_cost_usd != null || object.type === "result")) {
      const claude = extractClaudeCliUsage(object);
      if (!claude.usageUnknown) return claude;
    }
    const usage = object?.usage ?? object?.token_usage ?? object?.tokens;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const input = sumDefined(
      usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens,
      usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cachedInputTokens
    );
    const reasoning = positiveNumber(
      usage.reasoning_output_tokens ?? usage.reasoning_tokens ?? usage.reasoningTokens
    );
    const output = positiveNumber(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
    let visible = output;
    if (output != null && reasoning != null && output >= reasoning) {
      visible = output - reasoning;
    }
    const normalized = normalizeUsage({
      inputTokens: input,
      visibleOutputTokens: visible,
      reasoningTokens: reasoning,
      totalBilledTokens: usage.total_tokens ?? usage.totalTokens,
      monetaryCost: object.total_cost_usd ?? object.cost_usd ?? usage.cost_usd ?? usage.cost,
      usageSource: "provider_cli_structured",
      usageConfidence: "high"
    });
    if (!normalized.usageUnknown) {
      return normalized;
    }
  }

  return unknownUsage("no recognizable usage block in CLI JSON output");
}

/**
 * Parses either a single JSON document or a JSONL event stream. Returns every
 * object it could parse, in order. Never throws — unparseable input is simply
 * no evidence.
 */
export function parseJsonObjects(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isObject) : isObject(parsed) ? [parsed] : [];
    } catch {
      // Fall through to line-wise parsing — a JSONL stream also starts with "{".
    }
  }

  const objects = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (isObject(parsed)) objects.push(parsed);
    } catch {
      // Not every line of a CLI's stdout is an event; skip quietly.
    }
  }
  return objects;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Content extraction for a structured-CLI response. Mirrors the usage readers
 * above so a provider switched to JSON output still returns prose to the
 * caller. Falls back to the raw text when nothing recognizable is present,
 * so enabling structured output can never blank out a response.
 */
export function extractStructuredCliContent(stdout) {
  const objects = parseJsonObjects(stdout);
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = objects[i];
    // Claude: { type: "result", result: "..." }
    if (typeof object.result === "string" && object.result.length) {
      return object.result;
    }
    // Common JSONL agent-message shapes.
    const text =
      object.message?.content ??
      object.item?.text ??
      object.text ??
      object.content ??
      object.delta?.content;
    if (typeof text === "string" && text.length) {
      return text;
    }
  }
  return null;
}

/**
 * Reconciles usage evidence for one attempt against what the request actually
 * observed, so a provider that reports nothing does not silently inherit the
 * previous attempt's numbers.
 */
export function bestUsage(...candidates) {
  const usable = candidates.filter((c) => c && !c.usageUnknown);
  if (!usable.length) {
    return unknownUsage("no provider reported usage for this attempt");
  }
  return usable.sort((a, b) => usageSourceRank(a.usageSource) - usageSourceRank(b.usageSource))[0];
}
