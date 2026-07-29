# PARAGON-D-004C: Model-Catalog Cleanup, Validation & Automatic Refresh — Evidence Report

Implementation worktree: `/home/sketch/Projects/paragon-d004c`, branched
from `origin/main` at `2327665` (merge of PARAGON-D-004B). Shipped as five
sequential PRs (#7–#11) — see "Delivery" below for the full table.
Production checkout (`/home/sketch/Projects/paragon-production`, service
`paragon.service`) is deployed at `03e99c5` and verified live — see
"Production refresh results" and "Exposed-only routing proof" below.

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
`selectRoute({ ..., catalog })` resolve routing candidates from the
catalog's live state for any provider the catalog has assessed (see scope
decision above). `src/openaiApi.js` always passes the live in-process
catalog (`catalogStore.get()`) into `selectRoute`, and
`src/server.js`'s `/api/routing/registry` endpoint does the same — the
dashboard "Model Routing" panel and the live per-request decision can
never diverge on eligibility, matching the existing
`scoreAndRankCandidates` invariant this codebase already enforces for
scoring.

**Exposed/validated-only registry.** `buildModelRegistry()` *omits* any
catalog-assessed model whose state isn't `exposed` or `validated`-within-TTL,
rather than including it with `automaticEligibility: false`. This matters
because the registry is the sole input to the ranking algorithm, the
dashboard panel, and the live route decision — so an unvalidated,
rejected, unavailable, blocked, or retired model is not merely
un-selectable, it never enters the scoring input at all and never appears
as an "excluded" row. Verified in production: 0 ranking rows across all 7
task types reference a model outside the exposed/validated set (see
"Exposed-only routing" below).

### Design: recompute-on-read, not a post-refresh hook

Keeping routing rankings current after each catalog refresh is handled by
**recomputing the registry from the current catalog on every read**, not
by a hook that fires after a refresh completes:

```
catalog refresh
    ↓
persist authoritative catalog (atomic write)
    ↓
every registry/ranking request rebuilds from the current catalog
```

`buildModelRegistry()` is a pure function over
`(config, statuses, catalog)` with no cache and no stored derived state, so
there is nothing to invalidate and no window in which rankings can lag the
catalog. A completed refresh — scheduled, manual, per-provider, or a
single-model validation — is reflected on the very next request or
dashboard load.

This is the intentional implementation of immediate catalog consistency,
not a shortcut around a missing hook. An explicit post-refresh recompute
step would introduce a second source of truth for the same facts, plus a
new failure mode where the catalog write succeeds but the recompute
doesn't — leaving rankings silently stale, which is precisely the class of
inaccuracy this directive exists to eliminate.

A post-refresh hook becomes justified only when a real side effect needs
one, e.g. precomputed ranking snapshots, notifications about added or
removed models, historical catalog-diff reports, or external cache
invalidation. None of those exist today, so none is implemented.
Regression test: `buildModelRegistry reflects a completed catalog refresh
immediately — no separate 'refresh the registry' step exists`
(`test/modelRegistry.test.js`).

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
- `POST /api/model-catalog/validate-all` — walks every non-alias,
  non-retired model in the catalog across every enabled provider and
  probes each one individually. A model that fails is recorded and the run
  continues to the next; a single failure never aborts the run, and the
  failed model simply stays unvalidated. 409 if a run is already in
  progress.

All five inherit the existing dashboard admin auth
(`app.use("/api", adminAuth)` in `server.js` — unchanged).

## Dashboard

New "Model Catalog" panel (`public/index.html` + `public/app.js`,
collapsible like the existing Model Routing/Orchestration panels): table
of provider/model/state/auto-eligible/discovery source/last
validated/last failure, "Refresh all providers" and "Validate all"
buttons, and a per-row "Validate now" button. States render through a
label map so `unknown` reads as "Candidate only" rather than a bare enum
value — never shown as if it were an available model.

The panel polls every 24h rather than every 30s: the catalog only changes
on a refresh or validate action, and each of those re-renders the table
from its own response immediately, so a short poll added load without
adding freshness. (The Model Routing panel still polls every 30s — its
data is derived live from the catalog per the recompute-on-read design
above, so a short poll there is meaningful.)

### Probe cost

Validation probes send a minimal one-word prompt, and additionally set
`max_tokens: 1` for HTTP-compatible providers (`runHttpProvider`). The
builtin CLI providers (claude/codex/cursor/antigravity) expose no
equivalent token-cap flag — checked against each CLI's `--help` — so for
those the minimal prompt is the only lever available. Documented here
rather than claiming a hard cap that doesn't exist.

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

## Delivery

Shipped as five sequential PRs, each CI-green, squash-merged, and
fast-forwarded into `paragon-production` before the next was started:

| PR | Merge | What |
|---|---|---|
| #7 | `aed6920` | Core implementation (catalog state machine, refresh, scheduler, routing gate, dashboard, API) |
| #8 | `91e350c` | Fix: model-failure classification missed real claude CLI error text (found in production, see below) |
| #9 | `a4ee6f3` | Evidence report with production deployment proof |
| #10 | `7b937a3` | 24h catalog panel poll, "Validate all" button, `max_tokens: 1` HTTP probes |
| #11 | `03e99c5` | Registry lists only exposed/validated models (not merely marks others ineligible) |

Production deployed at `03e99c5`. Details of the initial deployment:

- Branch pushed, PR #7 opened against `main`, CI green, squash-merged as
  `aed6920`.
- `paragon-production` fast-forwarded `2327665` → `aed6920` — diff
  matched the PR exactly (21 files, no unrelated changes), `data/config.json`
  (API key, Tailscale host, ports 10000/9420, all 5 provider
  configs/routing weights) untouched by the fast-forward.
- Pre-restart backup: `data/backups/pre-d004c-20260729_130615/config.json`
  (no pre-existing `model-catalog.json` to back up — first run of this
  feature).
- `paragon.service` restarted (sudo run by the operator; each restart in
  this report was operator-executed, not run by the agent). Confirmed
  `ActiveState=active`, `NRestarts=0`, `/health` OK, new PID, ports
  10000/9420 unchanged, `/v1/models` still lists `paragon`.

### A real bug found during production verification, fixed, and redeployed

The very first production refresh cycle (see "Production refresh
results" below) revealed `classifyModelFailure()` was misclassifying a
genuinely invalid Claude model as `TRANSIENT_FAILURE` instead of
`MODEL_NOT_FOUND`. Root cause: `error.stderr ?? error.stdout` — `??`
only falls through on `null`/`undefined`, and `cli.js::runProcess` always
sets `error.stderr` to a string (often `""`), so a diagnostic that landed
on stdout was silently never read. Confirmed against the real installed
`claude` CLI:

```
$ claude -p --tools "" --model claude-does-not-exist-999 <<< "..."
(stdout) There's an issue with the selected model (claude-does-not-exist-999).
         It may not exist or you may not have access to it.
(stderr) (empty)
exit 1
```

Fixed (concatenate both streams unconditionally, extended the match
patterns to the real phrasing), covered by a new regression test
reproducing the exact stdout-only/empty-stderr shape, shipped as PR #8
(rebased cleanly onto the post-squash `main` — `git rebase` recognized
`02f201e`'s content as already applied and skipped it), merged as
`91e350c`, fast-forwarded into production, service restarted again to
pick it up. Re-tested against the same real CLI output afterward —
correctly classified `MODEL_NOT_FOUND`, model excluded from routing.

## Production refresh results (before → after)

Before this session, `paragon-production` had no model-catalog file at
all — routing eligibility came entirely from whatever was last saved to
`providerConfig.models` in `config.json`. The first automatic refresh
(fired on the first restart, per `refreshOnStartupIfStale`) produced:

| Provider | Candidates seen | Added | Removed (retired) | Rejected this cycle | Result state |
|---|---|---|---|---|---|
| Claude | 34 (documented + binary-scan candidates) | 34 | 0 | 2 (`claude-mythos-5`, `claude-fable-5` — transient, not hard-rejected) | 8 `validated` (bounded-probed, in budget), 25 `unknown` (candidate-only, outside the 10-probe budget or alias), 1 `rejected` (test artifact below) |
| Codex | 15 (live `codex debug models`) | 15 | 0 | 0 | 15 `exposed` (authoritative) |
| Cursor | 193 (`cursor-agent models`) | 193 | 0 | 0 | 193 `exposed` (authoritative) |
| Antigravity | 8 real records (11 raw lines, 3 filtered as non-model chrome by `parseAgyModelsOutput`) | 8 | 0 | 0 | 8 `exposed` (authoritative) |
| LM Studio (HTTP) | — | — | — | — | `ok: false, "fetch failed"` — endpoint unreachable (no local LM Studio server running); **previous entries kept, no synthetic fallback**, exactly per directive |

`cliVersion` recorded per provider: Claude `2.1.118 (Claude Code)`, Codex
`codex-cli 0.122.0`, Cursor `2026.07.23-e383d2b`, Antigravity `1.1.8`.

### Rejected-model-excluded-immediately proof

Manually validated a deliberately-nonexistent model
(`claude-does-not-exist-999`) via
`POST /api/model-catalog/providers/claude/models/claude-does-not-exist-999/validate`
— classified `MODEL_NOT_FOUND`, state `rejected`, and confirmed absent
from `/api/routing/registry`'s eligible set on the very next call (no
wait for a scheduled refresh). A subsequent full refresh then correctly
`retired` that same test entry (absent from the real candidate list) —
demonstrating authoritative-replace-not-merge live, not just in tests.
Final generation: `2`.

### Scheduler resume-across-restart proof

Captured `schedule` immediately before the third (resume-proof) restart:

```json
{"refreshing":false,"lastRefreshStartedAt":"2026-07-29T17:29:36.466Z",
 "lastRefreshCompletedAt":"2026-07-29T17:30:43.547Z",
 "lastSuccessfulRefreshAt":"2026-07-29T17:30:43.547Z",
 "nextRefreshAt":"2026-07-30T17:30:43.547Z"}
```

Identical `schedule` (byte-for-byte) and `generation` (`2`) immediately
after the restart — the scheduler resumed waiting for the persisted
`nextRefreshAt` rather than re-firing an immediate refresh, confirming
restart-safety with real production state, not just the mocked unit
tests.

### Exposed-only routing proof (final production state, at `03e99c5`)

After PR #11 deployed and the service restarted (PID `3442560`,
`16:12:04`), `/api/routing/registry` was cross-checked field-by-field
against `/api/model-catalog`:

| Provider | Catalog exposed/validated | Registry entries | |
|---|---|---|---|
| claude | 16 | 16 | match |
| codex | 15 | 15 | match |
| cursor | 193 | 193 | match |
| antigravity | 8 | 8 | match |

- Registry total: **257 → 238** entries; all **19** previously-listed
  non-eligible rows are gone.
- Registry rows with `automaticEligibility: false`: **0**.
- Registry rows in any state other than `exposed`/`validated`: **0**.
- Ranking algorithm: **1,666** ranked candidate rows across all 7 task
  types, of which **0** reference a model outside the exposed/validated
  registry — an unvalidated model appears neither ranked nor as an
  "excluded" row.
- Live end-to-end: a real `/v1/chat/completions` request routed to
  `claude-sonnet-5` (`X-Paragon-Route-Reason: scored.deterministic`),
  which the catalog independently confirms as `state: validated`,
  `automaticEligibility: true`, with a real `lastSuccessAt`.
- Scheduler after this restart: `generation: 3`,
  `nextRefreshAt: 2026-07-30T17:34:41.868Z` — exactly +24h from
  `lastSuccessfulRefreshAt`, persisted across the restart.

Note the pre-PR-#11 process was verified as *still running the old code*
before this restart (identical PID/start-timestamp predating the merge,
plus 19 `automaticEligibility: false` rows still present in the API
response) — the deployment was confirmed behaviorally, not assumed from
the checkout's git state.

### Requirement-by-requirement confirmation (production, not just tests)

| Requirement | Confirmed |
|---|---|
| Static Claude models candidate-only | Yes — 25/34 stayed `unknown` (candidate-only) this cycle |
| Claude binary strings candidate-only | Yes — `binary_candidate` entries all `unknown` unless bounded-probed |
| Bundled-only Codex candidate-only | Yes by design (live `codex debug models` succeeded this cycle, so all 15 came in `exposed`; unit tests cover the bundled-only-candidate path directly) |
| Cursor/Antigravity/HTTP/live-Codex authoritative replacement | Yes — all `exposed` directly, replace-not-merge demonstrated live via the test-artifact retirement |
| Auto-eligible = exposed or validated only | Yes — verified via `/api/routing/registry` cross-check against catalog state |
| Unvalidated models unusable by routing | Yes — omitted from the registry entirely, so absent from the ranking input (0/1,666 rows) |
| Routing lists/ranks only exposed models | Yes — registry set == catalog exposed/validated set for all 4 providers |
| Rankings stay current after each 24h refresh | Yes — recompute-on-read (no cache to invalidate); regression-tested and verified live |
| Models missing from a successful refresh removed | Yes — test artifact `retired`, not deleted or silently kept eligible |
| Rejected model excluded from the immediately following request | Yes — proven above |
| Model-specific failures don't disable the whole provider | Yes — Claude kept 8 `validated` models despite 2 rejections in the same cycle |
| No old configured model bypasses catalog eligibility | Yes — registry gates on catalog state for every provider the catalog has assessed |
| Provider-default routing attributed honestly | Unchanged code path, not modified by this work |
| Daily refresh enabled | Yes — `modelCatalog.enabled: true` (default) |
| Next refresh ~24h later | Yes — `nextRefreshAt` = `lastSuccessfulRefreshAt` + 24h, confirmed |
| Refresh state survives restart | Yes — proven twice (restart 2 and restart 3) |
| Overlapping refreshes prevented | `schedule.refreshing` lock (unit-tested); no overlap occurred in production (each refresh completed before the next restart) |
| No prompt/response/API key/credential persisted in catalog state | Yes — `grep` of `data/model-catalog.json` for credential-like strings returned nothing |
| Production active, stable NRestarts | Yes — `NRestarts=0` throughout all five restarts |
| Ports 10000/9420 unchanged | Yes |
| `/v1/models` still exposes `paragon` | Yes |
| Production checkout clean | Yes — `git status --short` empty at every checkpoint |

## Test totals

210 tests, all passing (`npm test`), plus `npm run check` (tests +
release script) and `git diff --check` green. Growth across the five PRs:
176 pre-directive → 203 (#7) → 204 (#8) → 207 (#10) → 210 (#11).

## Final verdict

**PARAGON_D004C_MODEL_CATALOG_COMPLETE**

Every automatic-eligibility path is gated on real evidence (an
authoritative account-aware source or a bounded execution probe/prior
success). Unvalidated, rejected, and retired models are excluded from the
routing registry entirely — so they cannot be ranked, selected, or
displayed as routable — and a model rejected at execution is excluded
from the immediately following request. The daily refresh runs with no
cron or systemd timer and survives restart with its schedule intact, and
rankings track the catalog with no staleness window by construction
(recompute-on-read, documented above as the intended design).

All of this was verified against the live `paragon-production` service,
not only the implementation worktree's test suite — including confirming
deployments behaviorally rather than trusting the checkout's git state,
which is how the one real defect in this work (the stdout/stderr
classification bug, PR #8) was caught and fixed before this verdict was
issued.
