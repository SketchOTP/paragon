/**
 * Observed subscription/quota state (PARAGON-D-004E, Phase 1).
 *
 * PARAGON reaches Claude, Codex, Cursor and Antigravity through subscriptions.
 * None of them expose an allowance-remaining API, so exact quota arithmetic is
 * not available. The directive's requirement is therefore not "compute the
 * allowance" but "behave safely and honestly when it is unknown":
 *
 *  - never claim a subscription request is free
 *  - track observed quota failures per provider
 *  - parse a reset time out of the provider's own error text when it gives one
 *  - exclude an exhausted provider until that reset, or until it succeeds again
 *  - express scarcity as a relative resource cost, never an invented dollar figure
 *
 * The parser below is built against a **real** observed provider error rather
 * than an imagined one — cursor-agent, at its monthly limit:
 *
 *   "ActionRequiredError: You've hit your usage limit ... Your usage limits
 *    will reset when your monthly cycle ends on 8/12/2026."
 *
 * In-memory by design: an exhaustion observation describes this process's
 * experience right now. A restart correctly re-probes rather than replaying a
 * stale exclusion from disk.
 */

/** Failure classifications that mean "this provider's allowance is spent", not "this model is bad". */
const QUOTA_CLASSIFICATIONS = new Set(["QUOTA_EXHAUSTED", "ENTITLEMENT_REQUIRED"]);

/**
 * How long to exclude a quota-exhausted provider when its error text gives no
 * parseable reset time. Deliberately short relative to a real billing cycle:
 * the cost of re-probing once an hour is one failed attempt, while the cost of
 * excluding a recovered provider for a month is a dead provider.
 */
const DEFAULT_EXCLUSION_MS = 60 * 60 * 1000;

/** Upper bound on any parsed reset, so a misparsed date cannot exile a provider for years. */
const MAX_EXCLUSION_MS = 40 * 24 * 60 * 60 * 1000;

/**
 * Extracts a reset instant from provider error text.
 *
 * Returns `{ resetAt, resetSource }` or null when the provider said nothing
 * usable. Never guesses a date — an unparseable message yields null and the
 * caller applies the bounded default exclusion instead.
 */
export function parseQuotaReset(text, { now = Date.now() } = {}) {
  const raw = String(text ?? "");
  if (!raw) {
    return null;
  }

  // 1. Explicit ISO timestamp: "resets at 2026-08-12T00:00:00Z".
  const iso = raw.match(/\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/);
  if (iso) {
    const parsed = Date.parse(iso[1]);
    if (Number.isFinite(parsed) && parsed > now) {
      return { resetAt: new Date(parsed).toISOString(), resetSource: "provider_iso_timestamp" };
    }
  }

  // 2. US-style calendar date, as cursor-agent reports it: "cycle ends on 8/12/2026".
  const slash = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) {
    const [, month, day, year] = slash;
    const parsed = Date.UTC(Number(year), Number(month) - 1, Number(day));
    if (Number.isFinite(parsed) && parsed > now) {
      return { resetAt: new Date(parsed).toISOString(), resetSource: "provider_calendar_date" };
    }
  }

  // 3. Relative window: "try again in 25 minutes", "resets in 3 hours".
  const relative = raw.match(/\bin\s+(\d+)\s*(second|minute|hour|day)s?\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[relative[2].toLowerCase()];
    if (Number.isFinite(amount) && unitMs) {
      return { resetAt: new Date(now + amount * unitMs).toISOString(), resetSource: "provider_relative_window" };
    }
  }

  return null;
}

/**
 * Per-provider quota observation store.
 *
 * Nothing here is a routing *score* — it is a hard gate plus a scarcity
 * signal. Scoring lives in costModel.js/expectedUtility.js.
 */
export function createQuotaStateStore({ defaultExclusionMs = DEFAULT_EXCLUSION_MS } = {}) {
  /** provider -> { exhaustedAt, resetAt, resetSource, observedFailures, lastDetail } */
  const byProvider = new Map();

  function clampReset(resetAt, now) {
    const parsed = Date.parse(resetAt);
    if (!Number.isFinite(parsed)) {
      return new Date(now + defaultExclusionMs).toISOString();
    }
    return new Date(Math.min(parsed, now + MAX_EXCLUSION_MS)).toISOString();
  }

  return {
    /**
     * Records a provider-wide quota/entitlement failure. `detail` is the
     * provider's own bounded error text, used only to parse a reset time —
     * it is never persisted or shown as-is in the product UI.
     */
    recordQuotaFailure(provider, { classification, detail = "", now = Date.now() } = {}) {
      if (!provider || !QUOTA_CLASSIFICATIONS.has(classification)) {
        return null;
      }
      const parsed = parseQuotaReset(detail, { now });
      const previous = byProvider.get(provider);
      const state = {
        exhaustedAt: new Date(now).toISOString(),
        resetAt: clampReset(parsed?.resetAt ?? new Date(now + defaultExclusionMs).toISOString(), now),
        resetSource: parsed?.resetSource ?? "bounded_default",
        classification,
        observedFailures: (previous?.observedFailures ?? 0) + 1
      };
      byProvider.set(provider, state);
      return state;
    },

    /**
     * A successful execution is authoritative recovery evidence — it outranks
     * any parsed reset time, because the provider just proved it is serving.
     */
    recordSuccess(provider) {
      if (provider) {
        byProvider.delete(provider);
      }
    },

    /** True while the provider should be excluded from routing entirely. */
    isExhausted(provider, { now = Date.now() } = {}) {
      const state = byProvider.get(provider);
      if (!state) {
        return false;
      }
      if (Date.parse(state.resetAt) <= now) {
        // Reset has passed: stop excluding, but keep no memory of scarcity we
        // can no longer justify.
        byProvider.delete(provider);
        return false;
      }
      return true;
    },

    state(provider, { now = Date.now() } = {}) {
      if (!this.isExhausted(provider, { now })) {
        return null;
      }
      return { provider, ...byProvider.get(provider) };
    },

    /**
     * 0..1 relative scarcity for the whole deployment, derived from how many
     * providers are currently exhausted. Feeds the quota-scarcity penalty so
     * remaining allowance is spent more carefully as providers drop out —
     * a *relative* signal, never a claim about real remaining allowance.
     */
    scarcity(config, { now = Date.now() } = {}) {
      const enabled = Object.entries(config?.providers ?? {}).filter(([, c]) => c?.enabled);
      if (!enabled.length) {
        return 0;
      }
      const exhausted = enabled.filter(([provider]) => this.isExhausted(provider, { now })).length;
      return Math.min(1, exhausted / enabled.length);
    },

    /** Read-only snapshot for Diagnostics. */
    snapshot({ now = Date.now() } = {}) {
      const out = {};
      for (const provider of [...byProvider.keys()]) {
        const state = this.state(provider, { now });
        if (state) out[provider] = state;
      }
      return out;
    },

    reset() {
      byProvider.clear();
    }
  };
}
