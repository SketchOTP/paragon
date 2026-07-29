/**
 * Bounded in-memory store of shadow decisions (PARAGON-D-004D, Phase 12).
 *
 * A ring buffer, not a log: the newest N records are retained and older ones
 * are dropped, so shadow mode cannot grow memory with traffic. Records
 * contain only the derived task profile and numeric components — never
 * prompts, responses or credentials (see buildShadowRecord).
 *
 * Deliberately in-memory: shadow evidence is for comparison during the
 * evaluation window, and persisting it would add a write to the hot request
 * path for data that the separate activation directive will summarize.
 */

export function createShadowStore({ limit = 200 } = {}) {
  const records = [];
  let totals = { total: 0, agrees: 0, disagrees: 0, noShadowWinner: 0, errors: 0 };

  return {
    record(entry) {
      records.push(entry);
      while (records.length > limit) {
        records.shift();
      }
      totals.total += 1;
      if (!entry.shadow) totals.noShadowWinner += 1;
      else if (entry.agrees) totals.agrees += 1;
      else totals.disagrees += 1;
      return entry;
    },
    recordError() {
      totals.errors += 1;
    },
    list({ limit: max = 50 } = {}) {
      return records.slice(-max).reverse();
    },
    /** Aggregate live-vs-shadow disagreement summary for the evidence report. */
    summary() {
      const byPair = new Map();
      for (const entry of records) {
        if (!entry.shadow) continue;
        const key = `${entry.live.provider}/${entry.live.model} -> ${entry.shadow.provider}/${entry.shadow.providerModelId}`;
        const existing = byPair.get(key) ?? { key, count: 0, agrees: entry.agrees };
        existing.count += 1;
        byPair.set(key, existing);
      }
      return {
        ...totals,
        agreementRate: totals.total ? totals.agrees / totals.total : null,
        retained: records.length,
        limit,
        topTransitions: [...byPair.values()]
          .filter((p) => !p.agrees)
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
      };
    },
    reset() {
      records.length = 0;
      totals = { total: 0, agrees: 0, disagrees: 0, noShadowWinner: 0, errors: 0 };
    }
  };
}
