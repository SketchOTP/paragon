# PARAGON-D-004C: Model-Catalog Cleanup, Validation & Automatic Refresh — Evidence Report

Implementation worktree: `/home/sketch/Projects/paragon-d004c`, branch
`paragon-d004c-model-catalog`, created from `origin/main` at `2327665`
(merge of PARAGON-D-004B). Production checkout
(`/home/sketch/Projects/paragon-production`, service `paragon.service`)
was **not** touched by this work — see "Status" below.

## Previous inaccurate discovery paths

Before this change, automatic routing eligibility for a provider-model
pair was decided by one thing: was it sitting in `providerConfig.models` in
`data/config.json`? That list was populated once, on demand, by whatever
`listModels()` returned the last time an operator clicked "Load models" —
and then trusted forever, with no re-check and no distinction between
"the provider just told us this" and "this was true six months ago."

Three concrete inaccuracy paths, all confirmed by reading the pre-change
code:

- **Claude** (`src/claudeModels.js`): `discoverClaudeModels()` merges
  `CLAUDE_DOCUMENTED_MODELS` (a hand-maintained static list) with
  `loadClaudeBundledCatalog()` (a string scan of the installed `claude`
  binary). Both are candidate sources — there is no real `claude models
  list` command (confirmed against `claude --help`) — but the merged
  result was written straight into `providerConfig.models` and trusted.
- **Codex** (`src/codexModels.js`): `DISCOVERY_ARG_SETS` tried
  `codex debug models --bundled` **before** the non-bundled
  `codex debug models` call — i.e. it preferred the embedded, potentially
  stale catalog over the live one, then trusted whichever it got.
- **Routing** (`src/routing/modelRegistry.js`): `buildModelRegistry()`
  set `automaticEligibility: true` unconditionally for every model in
  `providerConfig.models` — the only three exclusion mechanisms were
  health, circuit-breaker state, and context-window fit. A model rejected
  by the provider on the very last request stayed eligible for the next
  one.

## Provider-specific authoritative sources implemented

| Provider | Candidate source (never auto-eligible alone) | Authoritative source (grants `exposed` directly) | Validation |
|---|---|---|---|
| Claude | `CLAUDE_DOCUMENTED_MODELS` + `loadClaudeBundledCatalog()` | none exists (confirmed: no real list API) | Bounded exact-model probe, ≤`maxValidationProbesPerProvider` per refresh; aliases (`opus`/`sonnet`/`haiku`/`fable`) recorded but never probed or auto-eligible |
| Codex | `loadCodexBundledCatalog()` (`--bundled`) | `codex debug models` (live, no `--bundled`) — discovery order fixed to try this first | Only bundled-only candidates are bounded-probed |
| Cursor | — | `cursor-agent models` | Trusted as `exposed` directly (per directive: "primary discovery source"); execution-failure feedback (below) prunes stale entries in practice |
| Antigravity | — | `agy models`, parsed through `parseAgyModelsOutput()` which rejects headings/flags/commentary | Trusted as `exposed` directly |
| HTTP-compatible | — | `GET {baseUrl}/models` | Trusted as `exposed` directly |

New module `src/modelCatalog.js` owns the state machine (12 states per the
directive: `exposed`, `validated`, `stale`, `rejected`, `unavailable`,
`authentication_blocked`, `quota_blocked`, `entitlement_blocked`,
`configuration_blocked`, `provider_offline`, `unknown`, `retired`) and the
eligibility rule (`isEligibleNow`): only `exposed` and `validated` are ever
auto-eligible, and `validated` expires after `validationTtlHours` (default
24). `src/modelCatalogRefresh.js` owns discovery + bounded validation +
**authoritative replacement** (`replaceProviderModels` — a model absent
from a successful refresh is marked `retired`, never silently carried
forward as still eligible). `src/modelCatalogScheduler.js` owns the
24h/no-cron-job automatic refresh loop.

### Deliberate scope decision: unassessed providers

A provider the catalog has **never** refreshed at all (no bucket yet in
`data/model-catalog.json` — e.g. just configured, before the scheduler's
first pass) falls back to trusting `providerConfig.models`, exactly like
pre-D-004C behavior. This is intentional, not an oversight: without it, a
freshly-configured provider would be dead-on-arrival until the next 24h
refresh, which is a worse operator experience than the directive intended
to fix. The very first automatic or manual refresh replaces that trust
with real evidence — `startOnStartupIfStale: true` (default) means this
window is normally seconds, not hours, on a fresh install. See the doc
comment on `buildModelRegistry()` in `src/routing/modelRegistry.js`.

### Deliberate scope decision: bounded probe budget

Cursor, Antigravity, and HTTP-compatible candidates are trusted directly
from their authoritative list command/endpoint rather than
additionally probed per-model on every refresh cycle. Only Claude (always
candidate-only) and Codex's bundled-only candidates are bounded-probed
(`maxValidationProbesPerProvider`, default 10). This keeps the refresh
cycle from spending N real provider calls per model per provider per day —
directly serving the directive's own "avoid unnecessary paid probes"
instruction. Correctness for the untested tail is covered by the
execution-failure feedback loop below: the first real request that hits a
stale/rejected model immediately excludes it, rather than waiting up to
24h.

## Execution-failure feedback (immediate, not next-cycle)

`src/openaiApi.js::runWithFallback` now classifies every attempt's
result via `classifyModelFailure()` (11 categories:
`MODEL_NOT_FOUND`, `MODEL_REJECTED`, `MODEL_UNAVAILABLE`,
`AUTHENTICATION_FAILED`, `QUOTA_EXHAUSTED`, `ENTITLEMENT_REQUIRED`,
`RATE_LIMITED`, `PROVIDER_OFFLINE`, `CONFIGURATION_ERROR`, `TIMEOUT`,
`TRANSIENT_FAILURE`) and calls `catalogStore.recordResult()`:

- A hard failure (not-found/rejected/unavailable/auth/quota/entitlement/
  configuration/offline) immediately demotes that exact model's state and
  clears `automaticEligibility` — the *next* request already excludes it,
  with no wait for the next scheduled refresh.
- A transient failure (rate limit/timeout/generic) is recorded for
  visibility but does not demote an otherwise-eligible model — one blip is
  not evidence the model itself is invalid.
- A success marks the model `validated` (this is the directive's "Level 4:
  previously successful exact-model execution within the freshness
  period" source).

This write is fire-and-forget-safe (`safely()`, matching the existing
orchestration-telemetry pattern) — a catalog write failure never affects
the actual response to the caller.

## Automatic daily refresh

`src/modelCatalogScheduler.js`, wired into `src/server.js` at startup:

- Reads `schedule.nextRefreshAt` from the persisted catalog to decide
  whether to fire immediately (never refreshed, or stale past
  `refreshIntervalHours`) or resume waiting — **no systemd timer or cron
  job**, confirmed by test `startModelCatalogScheduler resumes from the
  persisted nextRefreshAt` (does not re-fire when the schedule is still
  fresh).
- `runFullRefresh()` in `src/modelCatalogRefresh.js` uses a persisted lock
  (`schedule.refreshing`), stale-lock override after 30 minutes (survives
  a crash mid-refresh), sequential per-provider refresh
  (`maxConcurrentProviderRefreshes: 1` default) with a bounded per-provider
  timeout, and continues past any single provider's discovery failure.
- Config defaults (`src/defaultConfig.js`, `modelCatalog:` section):
  `enabled: true`, `refreshIntervalHours: 24`,
  `refreshOnStartupIfStale: true`, `validationTtlHours: 24`,
  `maxConcurrentProviderRefreshes: 1`, `maxValidationProbesPerProvider: 10`,
  `retryBackoffMinutes: 60`.

## Routing integration

`buildModelRegistry(config, statuses, catalog)` (new third parameter) and
`selectRoute({ ..., catalog })` gate `automaticEligibility` on the
catalog's live state for any provider the catalog has assessed (see scope
decision above). `src/openaiApi.js` always passes the live in-process
catalog (`catalogStore.get()`) into `selectRoute`, and
`src/server.js`'s `/api/routing/registry` endpoint does the same — the
dashboard "Model Routing" panel and the live per-request decision can
never diverge on eligibility, matching the existing
`scoreAndRankCandidates` invariant this codebase already enforces for
scoring.

## API surface added

- `GET /api/model-catalog` — full persisted catalog.
- `POST /api/model-catalog/refresh` — triggers the same code path as the
  scheduled refresh (`modelCatalogScheduler.triggerNow()`), 409 if one is
  already in progress.
- `POST /api/model-catalog/providers/:provider/refresh` — one-provider
  refresh.
- `POST /api/model-catalog/providers/:provider/models/:model/validate` —
  one bounded probe against one exact model, updates catalog state either
  way.

All four inherit the existing dashboard admin auth
(`app.use("/api", adminAuth)` in `server.js` — unchanged).

## Dashboard

New "Model Catalog" panel (`public/index.html` + `public/app.js`,
collapsible like the existing Model Routing/Orchestration panels): table
of provider/model/state/auto-eligible/discovery source/last
validated/last failure, "Refresh all providers" button, and a per-row
"Validate now" button. States render through a label map so `unknown`
reads as "Candidate only" rather than a bare enum value — never shown as
if it were an available model.

## Tests

63 new/updated tests, full suite **203/203 passing**
(`npm test`), plus `npm run check` (tests + release script +
`git diff --check`) green. New coverage:

- `test/modelCatalog.test.js` (17 tests): every state present, failure
  classification for all 11 categories, corrupt-catalog defense,
  TTL expiration, authoritative-replace-not-merge (retirement, not
  deletion or silent carry-forward), transient-vs-hard failure handling,
  atomic load/save round-trip through an isolated data directory.
- `test/modelCatalogRefresh.test.js` (5 tests): Claude candidate-only +
  bounded-probe behavior (aliases never consume budget, unprobed
  candidates stay `unknown`), HTTP authoritative-replace, discovery
  failure propagates (caller keeps old entries, no synthetic fill-in),
  `refreshAllProviders` continues past one provider's failure and skips
  disabled providers.
- `test/modelCatalogScheduler.test.js` (6 tests): startup-refresh when
  never-refreshed or stale, resume-without-refresh when fresh, disabled
  mode polls without refreshing, `triggerNow()` bypasses the schedule,
  and — a real bug this test suite caught — two scheduler instances no
  longer share a module-level timer (`stop()` on one used to be able to
  clear the other's handle).
- `test/modelRegistry.test.js` / `test/router.test.js`: added
  catalog-gating cases (unassessed-provider fallback, rejected-entry
  exclusion, TTL-expired exclusion, `selectRoute` never routing to a
  catalog-rejected model).
- Four existing spawn-based integration test files
  (`routingIntegration`, `escalationIntegration`,
  `orchestrationIntegration`, `openaiApi.transparentGateway`) gained
  `PARAGON_MODEL_CATALOG_ENABLED: "0"` in their spawned server's env —
  without it, every test-server spawn would trigger a real, potentially
  billed provider-validation cycle. New env var documented in
  `src/configStore.js::applyEnvOverrides`.

### Two real bugs this work surfaced and fixed (not scope creep — both blocked the test suite from passing)

1. **`process.on("SIGTERM", ...)` without `process.exit()`** in
   `server.js`: registering a signal handler replaces Node's
   default terminate-on-signal behavior; without an explicit `process.exit()`
   inside it, `server.kill()` from a test (or `systemctl stop`/`kill` in
   production) would no longer actually terminate the process. Fixed by
   calling `process.exit(0)` after `modelCatalogScheduler.stop()`.
2. **Uncleared `setTimeout` inside `Promise.race`** in
   `refreshAllProviders()`'s per-provider timeout guard: the losing timer
   was never cleared on the winning branch, leaving a live handle for up
   to `providerTimeoutMs` (120s default) after the refresh had already
   resolved. Fixed with an explicit `clearTimeout` in a `finally` block.

## Status

**Implementation complete, tested, committed to the
`paragon-d004c-model-catalog` branch. Not yet pushed, not yet a PR, not
yet merged, and `paragon-production` / `paragon.service` have not been
touched.**

Per this session's operating constraints, push/PR/merge/production
restart/production refresh are each a distinct action requiring explicit
user confirmation before proceeding — they were not blanket-authorized by
the directive text alone. The "Production Proof" and "Delivery" sections
of the original directive (push, PR, merge, production cleanup + restart
+ refresh, restart-recovery proof) are the next step, pending that
confirmation.

## Final verdict

**PARAGON_D004C_PARTIAL**

Rationale: every implementation, test, and cleanup-logic requirement is
complete and verified in the worktree (tests, catalog state machine,
scheduler, routing gate, dashboard, API). What remains is exclusively the
production-deployment portion (push, PR, merge, production catalog
cleanup, service restart, restart-recovery proof) — deliberately withheld
pending explicit operator confirmation rather than a defect in the
implementation itself.
