# PARAGON-D-004C1: P0 Routing Integrity & Benchmark Attribution Hotfix — Evidence Report

Implementation worktree: `/home/sketch/Projects/paragon-d004c1`, branch
`paragon-d004c1-routing-integrity-hotfix`, from `origin/main` at `2dbb995`.
Merged as `379bca9` (PR #13). Production
(`/home/sketch/Projects/paragon-production`, service `paragon.service`)
deployed at `379bca9`, restarted 2026-07-29 18:23:49 EDT (PID 3600259),
and verified live.

Bounded corrective release. No part of the PARAGON-D-004D ranking
redesign is included.

## Confirmed production defects

All eight were verified against the *running* production instance before
any code was written — not inferred from reading the source.

| # | Defect | Evidence |
|---|---|---|
| P0-1 | `fallback.staticDefault` rebuilt attempts from `routing.taskRoutes` / `defaultProvider` / `fallbackChain` + `providerConfig.model`, bypassing catalog eligibility, cost ceiling and capability gates | `buildProviderAttempts()` read `config.providers[name]` directly, including `.model` |
| P0-2 | `X-Paragon-Force-Provider/Model` resolved from config *before* cost filtering, health, circuit, context and catalog checks; an absent model fell through to `providerConfig.model` | `selectRoute()` returned at `router.js:278` ahead of every gate |
| P0-3 | D-004C's CATALOG CLEANUP item 4 — "clear `provider.model` when it references a removed model" — was specified but never implemented | `grep` confirmed no catalog code path ever wrote `config.providers[x].model` |
| P0-4 | A provider with no catalog bucket fell back to trusting `providerConfig.models` | 6 never-validated LM Studio models were live in the registry with `automaticEligibility: true` |
| P0-5 | Every discovered model was labeled `coding/tools/streaming: true` | `jina-embeddings-v5-text-small-retrieval` and `text-embedding-nomic-embed-text-v1.5` were routable for chat completions |
| P0-6 | Benchmark matching was normalized substring containment with a "prefer the longest match" tiebreak | `claude-opus-4-20250514` matched **64 rows**; the tiebreak discarded the exact `Claude Opus 4` row in favour of `anthropic/claude-4.7-opus-20260416`, scoring a May-2025 model with an April-2026 model's coding index (**73.6**) and price (**$5.50/M**) |
| P0-7 | A failed benchmark refresh set `at: Date.now()` while retaining the old payload | Each failure bought another full 6h TTL of stale scores, indefinitely under sustained failure |
| P0-8 | `candidate.model \|\| providerConfig.model` at attempt construction | Could reintroduce a catalog-removed model at dispatch |

### Severity note: P0-4 and P0-5 compounded, live

`lmstudio` was enabled and in `fallbackChain`, its HTTP discovery was
failing (`fetch failed`), so it had no catalog bucket at all. It therefore
took the config-trust path — putting six unvalidated models into the
routable registry, two of which are embedding models that cannot serve a
chat completion under any circumstances. They were unranked only because
the provider happened to be `unhealthy`; had that endpoint come back
before a successful refresh, embedding models would have become live chat
routing candidates.

### Correction to the PARAGON-D-004C evidence report

That report claimed "0 of 1,666 ranked rows reference a non-exposed
model." The statement was true but proved less than asserted: the
cross-check iterated `Object.entries(catalog.providers)`, so a provider
with *no* bucket was structurally invisible to it. The zero held because
`lmstudio` was unhealthy, not because catalog gating caught it. This
report enumerates from the registry side instead.

## What changed

### P0-1 — static fallback removed

`buildProviderAttempts()` and `pickEnabledProvider()` are deleted. Every
live attempt originates from `buildRankedAttempts()` over the eligible
registry. An empty eligible set returns a bounded
`503 paragon_routing_error / no_eligible_model`. `routing.fallbackChain`
and `routing.defaultProvider` remain in config as scoring preference
inputs; they are no longer an independent dispatch path.

### P0-2 — forced routes gated

A forced route now resolves against the eligible registry and is scored
through the same hard gates (health, circuit, context fit, cost ceiling,
chat capability). Forcing can only ever *narrow* the candidate set.
Ineligible forced routes return a bounded `400` with a specific reason
code; there is no fallback to `providerConfig.model`. An unrestricted
operator override was deliberately **not** added and is not exposed on
`/v1`.

### P0-3 — configured-model cleanup

`reconcileConfiguredModels()` (pure, in `src/modelCatalog.js`) clears any
`config.providers[x].model` the catalog no longer considers eligible,
never substituting a replacement, and persists atomically via
`writeConfig()`. Wired into startup, the scheduled refresh, manual
refreshes and single-model validation, logging
`routing.configuredModelCleared`. Only providers the catalog has actually
assessed are touched — an unassessed provider's configured model is
untrusted for routing but not destroyed, since no authoritative refresh
has contradicted it.

### P0-4 — unassessed-provider trust removed

A provider with no completed assessment is reported `pending_assessment`
with `automaticEligibility: false` and contributes zero routable entries.
A *failed* refresh leaves it unavailable rather than trusted (a failure
throws before `replaceProviderModels`, so no bucket is fabricated).
Newly enabled providers get an immediate bounded refresh instead of
waiting for the 24h cycle.

### P0-5 — minimum chat-capability gate

New `src/modelCapability.js`. Models positively identified as non-chat —
via provider metadata (`type`/`task`/`object`/`capability`, now captured
from OpenAI-compatible `/v1/models`) or explicit segment-anchored id
patterns — cannot enter the chat registry. Deliberately minimum scope:
`chatCompletions` only. Tool-call, JSON-schema, multimodal and reasoning
profiles remain D-004D scope and are **not** guessed at. `unknown` never
becomes `true` for an unassessed provider. Patterns are anchored on
word/segment boundaries rather than bare containment, because a false
positive would silently delete a working chat model.

### P0-6 — benchmark attribution

Matching is equality-only, in order: exact canonical id, exact
date-stripped canonical id, explicit reviewed alias. Containment, family
inference and nearest-name matching are gone. `canonicalModelKey()`
deliberately preserves version and variant information — that stripping
was the collision's root cause. Only a trailing release-date snapshot is
removed, which is safe because comparisons are equality:
`claudeopus4` can never equal `claudeopus47`. Every annotation records
`matchMethod`, `matchConfidence`, `matchedLocalModel`,
`matchedBenchmarkModel` and `benchmarkFetchedAt`.

`EXPLICIT_BENCHMARK_ALIASES` ships empty by design: an alias is a human
assertion that two differently-named records are the same model, and is
the only sanctioned way to cross a version or variant boundary.

**Interpretation recorded:** the directive lists three allowed match
methods but then says "only `exact` and `explicit_alias` may influence
routing." Since method #2 (exact *normalized*) is explicitly allowed, it
would be contradictory to bar it from routing; all three are treated as
high-confidence and routing-eligible, with the precise method always
recorded so any future tightening is a one-line change.

### P0-7 — benchmark cache staleness

`lastAttemptAt` and `lastSuccessfulFetchAt` are tracked separately. A
failure advances only the attempt clock and preserves the payload
verbatim, so repeated failures cannot launder stale data into looking
fresh. Retry cadence keys on attempts (6h), usability on the last
success. Data past `MAX_USABLE_AGE_MS` (24h) stays visible for
diagnostics but is withheld from live scoring *and* from the dashboard
panel, keeping the panel's ranking identical to the live decision.

### P0-8 — attempt-chain integrity

`verifyAttemptsAgainstRegistry()` re-derives every attempt against the
current registry immediately before dispatch; a violation fails the
request rather than executing. A candidate with no resolved model is
dropped, never backfilled from config. Provider-default execution is an
explicit validated `PROVIDER_DEFAULT_MODEL_ID` registry entry, translated
to an empty `model` only at the point of dispatch.

### P0-9 — observability

Reason codes: `routing.noEligibleModel`, `routing.forcedModelNotEligible`,
`routing.forcedProviderNotEligible`, `routing.providerPendingAssessment`,
`routing.chatCapabilityUnsupported`, `routing.configuredModelCleared`,
`routing.benchmarkMatchRejected` (as "no confident match" — absence of an
annotation), `routing.benchmarkDataStale`, plus
`routing.attemptIntegrityViolation`. New headers:
`X-Paragon-Model-State`, `X-Paragon-Benchmark-Match`,
`X-Paragon-Catalog-Age`. No prompts, responses, API keys or credentials
are logged or persisted.

### Incidental bug fixed during implementation

Narrowing `let attempts` to `const` crashed **every live-mode request** at
the circuit/fallback filter (`Assignment to constant variable`). Caught by
the integration suite before merge, not in production.

## Before → after inventory (production)

| Provider | Registry before | Registry after | |
|---|---|---|---|
| claude | 16 | 16 | unchanged |
| codex | 15 | 15 | unchanged |
| cursor | 193 | 193 | unchanged |
| antigravity | 8 | 8 | unchanged |
| **lmstudio** | **6 (all routable)** | **1 (`pending_assessment`, 0 routable)** | 6 unvalidated models removed |
| **Total** | **238** | **233** (232 routable + 1 pending) | |

- Embedding models in the registry: **2 → 0**.
- Embedding rows in any task ranking: **0 → 0** (previously masked by
  provider health, now structurally excluded).
- Ranked candidate rows across all 7 task types: 1,666 → **1,624**.
- Benchmark-matched models: **227 → 48** (35 `exact`, 13
  `exact_normalized`, 0 anything else).

### The 227 → 48 drop is the point, and a real trade-off

179 models lost their benchmark annotation because those matches were
substring collisions, not identifications. Value scoring — the dominant
term, worth up to ±12 points — now applies to 48 models on evidence
instead of 227 on coincidence. The honest consequence is that the
majority of candidates are currently scored on the internal formula
alone. That is strictly better than scoring them on another model's
numbers, and it is why benchmark correctness was sequenced ahead of
outcome telemetry: calibrating weights against misattributed data would
have baked the error in. Closing the gap legitimately (canonical id
mapping, reviewed aliases, true marginal cost) is D-004D work.

### Configured-model cleanup outcome

No configured model needed clearing in production: all four assessed
providers' configured models are currently eligible
(`claude-opus-5` validated, `cursor/composer-2.5` exposed,
`antigravity/gemini-3.6-flash-high` validated, `codex` intentionally
empty). `lmstudio`'s configured `google/gemma-4-26b-a4b-qat` is absent
from the catalog but `lmstudio` is unassessed, so it is preserved by
design and contributes nothing routable regardless.

The mechanism itself is proven by `routingIntegrity.api.test.js`, which
boots a server against a pre-written stale config and asserts startup
reconciliation clears it and logs `routing.configuredModelCleared` —
i.e. verified against real behavior, not merely "nothing happened."

## Production proof (against PID 3600259 at `379bca9`)

| # | Proof | Result |
|---|---|---|
| 1 | No `fallback.staticDefault` route can occur | Source contains only removal comments; no dispatch path exists |
| 2 | Empty eligible registry returns `no_eligible_model` | `503`, `code: no_eligible_model`, `X-Paragon-Route-Reason: routing.noEligibleModel` |
| 3 | Forced rejected model denied | `400 routing.forcedModelNotEligible` for `claude-mythos-5` (state `rejected`) and for a nonexistent id |
| 4 | Forced unassessed provider denied | `400 routing.providerPendingAssessment` for `lmstudio` |
| 5 | No configured stale model dispatched | All assessed providers' configured models currently eligible; see above |
| 6 | `lmstudio` contributes zero routable models | 1 row, `pending_assessment`, `automaticEligibility: false` |
| 7 | Embedding models absent from registry and rankings | 0 in registry, 0 in any of 7 task rankings |
| 8 | Opus 4 no longer carries Opus 4.7's benchmark | Now `exact_normalized` → `anthropic/claude-4-opus-20250522` at $15/M (was `claude-4.7-opus` at 73.6 / $5.50M) |
| 9 | Every benchmark-influenced model has exact/alias attribution | 48/48: 35 `exact`, 13 `exact_normalized`, 0 other; 0 below `high` confidence |
| 10 | Failed refresh does not reset the successful-data timestamp | `lastAttemptAt` / `lastSuccessfulFetchAt` reported separately; regression-tested |
| 11 | Data beyond max age stops affecting routing | `applied: true`, `stale: false`, `dataAgeMs: 5054`, `maxUsableAgeMs: 86400000` |
| 12 | Every live attempt maps to a current eligible registry row | 0 `attemptIntegrityViolation` events |
| 13 | A normal valid request still completes | `200`; route `cursor/gpt-5.6-luna-max` (`scored.deterministic`), answered by `codex` after fallback; `X-Paragon-Model-State: exposed`, `X-Paragon-Benchmark-Match: exact` |
| 14 | Public API and dashboard ports unchanged | 10000 and 9420 listening on the tailnet address; `/v1/models` still lists `paragon` |
| 15 | Production checkout clean | `git status --short` empty at `379bca9` |
| 16 | Service active, no restart loop | `ActiveState=active`, `SubState=running`, `NRestarts=0` |

Proof 2 required a brief, exactly-reversible config toggle (all
catalog-assessed providers disabled so only the pending `lmstudio`
remained). Config was snapshotted via `GET /api/config`, restored
verbatim afterwards, and confirmed byte-identical
(`JSON.stringify(before) === JSON.stringify(after)`), with the API key,
Tailscale host and ports intact and no `provider.model` drift versus the
pre-deploy backup.

Backups: `data/backups/pre-d004c1-20260729_174513/{config.json,model-catalog.json}`.

## Tests

**262 passing** (`npm test`), up from 210; `npm run check` and
`git diff --check` green.

- `test/routingIntegrity.test.js` — 28 unit regressions
- `test/routingIntegrity.api.test.js` — 8 HTTP regressions
- `test/helpers/seedCatalog.js` — integration tests now seed a real
  persisted catalog instead of relying on config trust

All 25 directive-required cases are covered, including the Opus 4 /
Opus 4.7 collision, both named embedding models, substring rejection,
reasoning-variant isolation, startup reconciliation, forced-route cost and
context gates, and SmartRoute absence.

Tests that asserted the old bypassing behavior were **rewritten to the new
contract, not deleted** — e.g. `buildModelRegistry` "trusts
providerConfig.models" became "contributes zero eligible models and is
reported `pending_assessment`."

One test change deserves explicit note: `routingIntegration`'s antigravity
case previously asserted `run.provider === "antigravity"`. That began
failing because the real CLI is unusable in a hermetic sandbox, so its
model is (correctly) marked ineligible on execution failure and PARAGON
falls back — meaning `run.provider` reports whichever provider *answered*.
The assertion was retargeted to `X-Paragon-Route-Model`, which is the
routing decision the test was actually about, and the forced-route half
was moved to a deterministic fixture provider.

## Remaining D-004D scope

Not addressed here, by design:

1. Full request-capability profiles (tool calls, JSON schema, multimodal,
   reasoning controls)
2. Model-level outcome and latency telemetry feeding the scorer
3. Multidimensional task profiling (replacing first-match classification)
4. Same-provider model-aware fallback
5. Subscription/quota-aware true marginal cost
6. Expected-utility scoring
7. Explicit tie-breakers and evidence-based confidence
8. Shadow calibration before any live weight change

Known limitations carried forward: cost class is still inferred from model
names; context windows are still coarse family patterns; tie-breaks still
fall back to registry insertion order; `confidence` still reports
`scored` on a zero-point margin.

## Final verdict

**PARAGON_D004C1_ROUTING_INTEGRITY_COMPLETE**

Every path that could route outside the validated catalog is closed and
verified live: static fallback deleted, forced routes gated, unassessed
providers dark, non-chat models excluded, attempts re-verified at
dispatch, and configured-model cleanup implemented with startup
reconciliation. Benchmark attribution is equality-only with full
provenance, and stale benchmark data can no longer influence routing or
launder itself fresh. The confirmed production misattribution
(Opus 4 inheriting Opus 4.7's index and price) and the six unvalidated
LM Studio models — including two embedding models — are gone from the
live registry, with production stable at `NRestarts=0` and public URLs
unchanged.
