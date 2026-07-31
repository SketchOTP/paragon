# PARAGON Routing Intelligence V2 Qualification

## Current verdict

`PARAGON_ROUTING_INTELLIGENCE_V2_IMPLEMENTED_NOT_INDEPENDENTLY_QUALIFIED`

This report deliberately does not claim the final qualification verdict. A real
Artificial Analysis operator key was not available in the workspace, so live
account-tier, current-model, pagination, rate-limit, and server-only credential
proof remain outstanding. No external key was stored in this repository.

## Changeset integrity

- Authoritative base: `909509db52f8b3cdf587505e0d90157da3cbd6c8`
- Implementation head: `b1d233e` (`qualify routing intelligence v2 evidence paths`)
- Worktree: `/home/sketch/Projects/paragon-routing-intelligence-v2`
- Production checkouts modified: none
- Existing tests before: 382
- Tests after: 402 (20 new v2 tests)
- Deleted test files: none
- New test file: `test/routingIntelligenceV2.test.js`
- Credentials/evidence caches committed: none

## Scope

This branch replaces the request-level weighted-utility decision with a minimum-cost satisfactory decision. Hard eligibility remains first; candidates then receive confidence-adjusted success estimates, risk-specific sufficiency thresholds, actual-unit cost estimates, and a jointly evaluated fallback plan.

External evidence is refreshed outside `/v1` into an atomic evidence store. Artificial Analysis is server-side only and OpenRouter model data is scoped to OpenRouter tuples. Internal availability probes are separate from objective competence evaluation.

## Implemented evidence

- Fresh provider preference defaults are zero; zero points contribute exactly zero.
- Subscription/allowance burn is modeled separately from USD and Codex credits.
- Artificial Analysis key handling is masked in settings responses and supports server-side test, refresh, status, and explicit remove routes.
- Artificial Analysis records carry source, model identity, observation/fetch/expiry, confidence, attribution, and a raw-record hash.
- Live routing uses cached benchmark evidence and performs no external refresh.
- Risk thresholds are 0.78, 0.86, 0.91, 0.94, and 0.97 for the documented task-risk/complexity combinations; degraded routes are labeled `degraded_sufficiency`.
- Fallback plans account for conditional failures and provider correlation.
- The new suite covers pagination, tier parsing, 401/403/429 classification, rate-limit metadata, evidence hashes/freshness, cost-unit separation, plan optimization, zero preference, and degraded sufficiency.

## Outstanding qualification evidence

- Real server-mediated Artificial Analysis refresh with an operator-supplied key.
- Five-model Artificial Analysis/OpenRouter identity and deduplication records.
- Live current-price snapshots for OpenRouter and provider-owned pricing evidence.
- Objective evaluations executed against the requested real model tuples and loaded by live candidate scoring.
- Instrumented zero-outbound-call proof for ordinary `/v1` requests during concurrent refresh.
- Independent review of the complete committed diff and qualification artifact.

## Verification

`npm run check` passes: 402 tests, 0 failures, 0 skipped, and release checks pass. No production deployment or restart was performed. The implementation worktree is `/home/sketch/Projects/paragon-routing-intelligence-v2`.

Artificial Analysis attribution: Data provided by Artificial Analysis (artificialanalysis.ai).

Final verdict: `PARAGON_ROUTING_INTELLIGENCE_V2_IMPLEMENTED_NOT_INDEPENDENTLY_QUALIFIED`
