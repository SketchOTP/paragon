# PARAGON-D-004D1 — Dashboard Routing Truthfulness and Legacy Control Retirement

**Status:** complete, deployed, verified in production
**Production commit:** `8e1f975` (PR #17, squash-merged)
**Base commit:** `2ca7140`
**Service:** `paragon.service` active, `NRestarts=0`, PID 122137 started 2026-07-30 08:16:01 EDT
**Tests:** 352 passing (313 at base), `npm run check` green, `git diff --check` clean

The product rule this directive enforces:

> The dashboard must show what PARAGON actually controls, not preserve obsolete
> configuration as if it were authoritative.

Scope was dashboard and configuration-surface only. Live routing behavior is
unchanged: no change to the PARAGON-D-004C1 live decision, D-004D shadow
rankings, catalog eligibility, provider authentication, or provider execution.

---

## 1. Previously misleading controls, and the actual backend behavior

| Dashboard control | What it implied | What the backend actually does |
|---|---|---|
| Provider card `Model` dropdown (wrote `providers.<id>.model`) | "This is the model this provider will use" | Live attempts are built from ranked, catalog-eligible registry entries. PARAGON-D-004C1 removed the path that let dispatch substitute `providerConfig.model` at all. |
| `routing.defaultProvider` ("Default" selector) | "This provider is the default route" | The static-default fallback path was removed in D-004C1. An empty eligible set is a bounded `503 no_eligible_model`, not a downgrade to a configured provider. |
| `routing.fallbackChain` (visualization + editor) | "This is the order a request attempts providers" | Candidates and their order are derived per request from the ranked eligible registry, subject to circuit, cost, context, capability and catalog gates. |
| Task provider selections | Presented as direct task-to-provider mappings | Still read by the live scorer, but only as an additive `WEIGHTS.taskRoutePreference` (+3) bonus. Every eligibility and safety gate can and does override them. |

### The clearest instance, from the real production config

The LM Studio card's `Model` dropdown offered `google/gemma-4-26b-a4b-qat`,
while that provider had **no completed catalog assessment and zero routable
models** — `catalogState: pending_assessment`, `eligible: 0`. The control was
presenting a model that routing structurally cannot use, on a provider that
contributes nothing to routing at all.

This is visible in the before-screenshot below and is the reason the control was
not merely relabeled.

---

## 2. Before and after

Screenshots were taken headless against a copy of the **real production
config and model catalog** (5 providers, 251 catalog entries), so the values
shown are production values, not fixtures.

| | |
|---|---|
| Before — provider cards | `assets/d004d1-before-providers.webp` |
| Before — Routing panel | `assets/d004d1-before-routing.webp` |
| After — provider cards | `assets/d004d1-after-providers.webp` |
| After — Routing panel (live vs shadow) | `assets/d004d1-after-routing.webp` |
| After — attempt plans, legacy preferences, shadow settings, deprecated fields | `assets/d004d1-after-lower-panels.webp` |
| **Live production after deploy** | `assets/d004d1-production-live.webp` |

The before-shots show emoji glyphs, a `Model` dropdown per card reading
`Opus 5` / `gpt-5.3-codex` / `Composer 2.5` / `gemini-3.6-flash-high` /
`google/gemma-4-26b-a4b-qat`, a `Default: Codex` selector, a `Fallback chain`
button with a 4-chip chain visualization, and task rows rendered as bare
provider mappings. They also show the visual inconsistency that prompted the
UI half of this directive: the top metric cards carried `--glow-card` while the
provider cards had only the flat `--shadow`.

---

## 3. Removed controls

| Removed | Replaced by |
|---|---|
| Provider `Model` `<select>` (`data-key="model"`) and its `modelOptions()` populator | Read-only **Provider routing** summary (§4) |
| Per-card model refresh button (`data-refresh-models`) | Catalog refresh in the Model Catalog panel; per-model validation in the inspector |
| `Model` fields on the add-provider form (HTTP and CLI) | Nothing — models are discovered by the catalog refresh the server starts as soon as the provider is saved |
| `Default` provider `<select>` (`#default-provider`) | **Live router** status block (§5) |
| Fallback chain visualization (`#fallback-viz`) | **Fallback behavior** explanation + observed attempt plans (§6) |
| Fallback chain editor (`#fallback-dialog`, order list, add/remove/reorder) | Same |
| Client-side `ensureFallbackChain()` — the dashboard used to invent `["codex","cursor"]` when the field was absent | Nothing. The client no longer fabricates a value for a field it does not render. |
| Emoji icon picker (`#emoji-dialog`, `EMOJI_PICKS`) | Avatar control (§8). `providers.<id>.icon` is left in config untouched. |

Model testing is **retained** as an explicit advanced action, per the
directive: a **Validate / inspect catalog** button per card opens a per-model
inspector with a **Validate model** action. It uses the existing catalog
validation endpoint and updates catalog state only.

---

## 4. Provider card: the read-only routing summary

Every field is derived from the live catalog plus observed activity. Nothing on
the card is a stored operator preference.

```
PROVIDER ROUTING
  Eligible models          16
  Validated / exposed      16 / 0
  Rejected or unavailable  13
  Catalog refreshed        19h ago
  Last live model          gpt-5.4 (2m ago)
  Last shadow model        gpt-5.5-none-fast (2m ago)
  Provider default         not offered
  Health                   healthy
  Selection: automatic per request
```

`buildProviderRoutingSummaries()` (`src/routing/providerSummary.js`) is a pure
function over config + statuses + catalog + observed activity. It mirrors
`buildModelRegistry()`'s rule exactly — catalog eligibility **and** the
chat-capability gate — so the eligible count can never exceed what routing will
consider. A provider with no completed assessment reports
`catalogState: pending_assessment` with the reason stated on the card; a
disabled provider reports `disabled` rather than zeros that read as failure.

---

## 5. Live versus shadow router

```
Live router  [EXECUTES]                     Shadow router  [ADVISORY]
  Engine                 PARAGON-D-004C1      Engine                     PARAGON-D-004D
  Mode                   live                 Mode                       shadow
  Selection method       deterministic        Selection method           expected utility
                         score, per request   Affects provider execution no
  Candidate set          eligible catalog     Additional provider calls  no
                         models only          Agreement                  0 agree / 1 disagree of 1
  Task-provider pref.    yes (+3)             Latest live winner         cursor/gpt-5.6-luna-max
  Catalog eligibility    yes                  Latest shadow winner       cursor/gpt-5.5-none-fast
  Static default fb.     disabled             Latest shadow confidence   low
  Empty eligible set     503 no_eligible_model Telemetry buckets          0
```

The `+3` is read from `scoringMethodology().weights.taskRoutePreference` and
rendered from that value, so the label cannot drift from the code. The panel
states plainly: *"PARAGON-D-004C1 currently determines real execution.
PARAGON-D-004D is advisory only: it does not alter provider usage, model choice,
fallback order, or any response, and it issues no provider calls of its own."*

---

## 6. Attempt plans: decision versus execution

The directive asked for the current live attempt plan and the shadow attempt
plan, clearly labeled. Reviewing the diff before merge surfaced a truthfulness
bug in the first implementation, which is worth recording because it is exactly
the class of problem this directive exists to remove.

**The bug I shipped and then fixed:** the initial `recordLive()` ran at routing
time, *before* the live-enforcement gates. A request refused by the context
ceiling, the concurrency limit, or the session hard limit would still have
updated the provider card's "last live model" — the card would have claimed a
model ran when no provider was ever invoked.

The fix separates a decision from an outcome
(`src/routing/routeActivity.js`, commit `fbd5d3c`):

- `recordLivePlan()` — the ranked attempt plan the scorer produced. Recorded at
  routing time, because the plan genuinely was produced.
- `recordExecuted()` — the provider-model pair that actually returned the
  response. This is the only thing the card's "last live model" reads. Wired
  into both the JSON and the streaming response path (streaming owns its own
  fallback call, so it takes an `onExecuted` callback).

**This paid off on the first production request after deploy.** The route
header reported `cursor/gpt-5.6-luna-max`, but cursor hit its usage limit and
fallback recovered via codex:

```
12:17:23 cursor  route       Task code -> cursor (gpt-5.6-luna-max) [scored.deterministic]
12:17:26 cursor  error       exited 1: ActionRequiredError: You've hit your usage limit
12:17:26 codex   fallback    Trying codex after cursor failed
12:17:31 codex   fallback    Recovered using codex after cursor failed
12:17:31 codex   request     POST /v1/chat/completions → 200 (9058ms) via codex (routed cursor)
```

The dashboard correctly attributes `Last live model: gpt-5.4` to **codex**, not
to cursor. Under the original implementation the cursor card would have claimed
it ran `gpt-5.6-luna-max`.

The two recorded plans for that request, shown side by side and separately
labeled:

```
LIVE   (PARAGON-D-004C1): cursor/gpt-5.6-luna-max → codex/gpt-5.4 → claude/claude-sonnet-5 → antigravity/gemini-3.6-flash-high
SHADOW (PARAGON-D-004D) : cursor/gpt-5.5-none-fast → cursor/gpt-5.5-none → claude/claude-opus-4-0 → codex/gpt-5
```

Both are labeled as observations of real requests, with a timestamp and the
derived task-profile context — not a saved order.

---

## 7. Deprecated configuration fields — retained, not deleted

`src/deprecatedConfig.js` holds the machine-readable metadata the dashboard
renders verbatim, so the deprecation reason a reader sees is the single copy of
that text.

| Field | Superseded by | Status |
|---|---|---|
| `providers.*.model` | ranked catalog-eligible registry entries (per request) | deprecated, retained, hidden, not authoritative |
| `routing.defaultProvider` | `503 no_eligible_model` when the eligible set is empty | deprecated, retained, hidden, not authoritative |
| `routing.fallbackChain` | per-request ranked attempt plan | deprecated, retained, hidden, not authoritative |

Each carries `retainedForBackwardCompatibility: true`,
`authoritativeForLiveRouting: false`, `hiddenFromPrimaryDashboard: true`, and
`scheduledRemoval: "possible schema removal after D-004D activation and an
explicit config migration"`. Matching comments were added to `defaultConfig`.

**They are deliberately not deleted.** Removing a field from the persisted
schema is a config migration with its own rollback story, and deleting these
would silently lose operator state on a rollback to an earlier release. Schema
removal belongs to a later, explicitly-authorized migration directive.

`routing.taskRoutes` is **not** on that list. The live scorer still reads it, so
it is recorded separately in `ACTIVE_BUT_MISREPRESENTED_FIELDS` as an active
preference with `notARoute: true` — and it remains editable, under wording that
says exactly what it does.

---

## 8. UI: provider hero boxes and avatars

Also requested in this directive.

- Provider cards are now two-column grids: `132px minmax(0, 1fr)`. The avatar
  occupies the left column with `align-self: stretch` and `object-fit: cover`,
  so it runs the full height of the box; everything else sits in the right
  column.
- `.providers-grid` uses `repeat(auto-fill, minmax(360px, 1fr))` with
  `align-items: stretch`, so every card in a row is the same height and the
  avatar column matches it.
- Provider cards now carry the same `1px solid rgba(168, 85, 247, 0.3)` border
  and `--glow-card` as the top metric cards. Previously they had only the flat
  `--shadow` — the inconsistency that prompted the request.
- Bundled avatars ship for all five providers under `public/avatars/`. The five
  source PNGs (1024×1536, 7.4 MB total) were resampled to 440×660 WebP,
  **224 KB total**.
- Any provider — including one added later — can supply its own avatar. The
  add-provider dialog takes one directly, and each card's avatar is clickable to
  replace it or revert to the bundled asset.

Avatar uploads are stored as **files** under `data/avatars/`, served from
`/provider-avatars/`, with only the served path recorded in
`providers.<id>.avatar`. They are not inlined into `config.json` as base64: that
would bloat every config read on the request path and be re-sent in full by the
dashboard on every save. A test asserts the config never carries the base64
payload.

Uploads are accepted only after **magic-byte** inspection confirms PNG, JPEG or
WebP — the client-declared MIME type is not evidence of anything. A script
declared as `image/png` is rejected on its bytes. The provider id is validated
against `^[a-z0-9-]{1,64}$` before being used as a filename, and the size
ceiling is 2 MB.

### Two layout bugs found by screenshotting the result

Neither would have been caught by the test suite:

1. `overflow-wrap: anywhere` on the fact-value cell, inside a flex row with a
   non-shrinking label, let the value column collapse to near-zero width and
   then break words **one character per line** — "not offered by this provider"
   rendered as a vertical sliver. Replaced with a two-track grid that gives the
   value a real minimum width, plus `break-word` instead of `anywhere`.
2. `loading="lazy"` on the avatars left every avatar column empty at first
   paint. Removed — these are five small above-the-fold images.

Provider status output is also now clamped to two lines with the full text in
the `title` attribute, so a chatty provider (Claude prints a JSON auth blob;
Antigravity prints a model list) cannot stretch an entire grid row.

---

## 9. Wording

Removed: "Selected model", "Default", "Fallback chain" as an editable order,
task-routes-to-provider framing, "Model" as the metrics label for the exposed
gateway model id.

Adopted: "Eligible models", "Last live model", "Last shadow model",
"Legacy live provider preferences", "Ranked attempt plan", "Selection:
automatic per request", "Exposed model id", "Shadow recommendation".

Two panels were also renamed so Phase 6's separation is explicit rather than
implied: **Live routing & enforcement settings — PARAGON-D-004C1** and
**Shadow routing settings — PARAGON-D-004D**, with **Deprecated compatibility
fields** as a third, separate panel. Live and shadow settings are never
combined into one ambiguous Routing panel.

The shadow panel exposes only inputs that genuinely change the shadow
computation: quota scarcity, unknown large-context threshold, minimum telemetry
samples, maximum shadow attempts, telemetry retention. The operator-reviewed
mapping tables (canonical aliases, reasoning profiles, capability overrides,
context overrides) are displayed read-only with counts — a malformed hand-typed
mapping would silently change how every candidate is profiled.

`mode` is rendered read-only and the API refuses to write it:

```
PUT /api/routing-intelligence/settings {"mode":"live"} → 400
  "mode is not settable from the dashboard — live activation of D-004D
   requires its own directive"
```

---

## 10. Config-preservation proof (Phase 8)

Performed live against production. One task preference was changed through the
real dashboard save path, then restored.

```
changed taskRoutes.docs: antigravity -> claude

PRESERVED  defaultProvider      codex
PRESERVED  fallbackChain        ['codex', 'claude', 'cursor', 'lmstudio']
PRESERVED  providers.*.model    {'claude': 'claude-opus-5', 'codex': '',
                                 'cursor': 'composer-2.5',
                                 'antigravity': 'gemini-3.6-flash-high',
                                 'lmstudio': 'google/gemma-4-26b-a4b-qat'}
PRESERVED  server.apiKey        (unchanged)
PRESERVED  tailscaleHost        atlas-2.tail1a5964.ts.net
other task preferences altered: none

restored taskRoutes.docs -> antigravity
byte-diff of data/config.json against the pre-test copy: IDENTICAL
```

The hidden deprecated values round-trip because the dashboard PUTs the full
document it loaded from `GET /api/config`, changing only the fields it renders,
and nothing in the client invents a value for a field it no longer shows.

---

## 11. Production proof

All 18 directive checks, run against `8e1f975` on the restarted service.

| # | Check | Result |
|---|---|---|
| 1 | Provider cards no longer present one model as normally selected | `data-key="model"`, `modelOptions()`, `data-refresh-models` all absent from the served `app.js` |
| 2 | Provider eligible counts match the live catalog | claude 16, codex 15, cursor 193, antigravity 8, lmstudio 0 — card == catalog == registry for all five; 232 total, matching the 232 auto-eligible registry rows |
| 3 | Last live model displayed accurately | `codex / gpt-5.4` — the executor after cursor's quota failure, not the plan head |
| 4 | Last shadow model displayed accurately | `cursor / gpt-5.5-none-fast`, on a different card from the live model |
| 5 | Default-provider control absent | `#default-provider` absent from served markup |
| 6 | Fallback-chain control absent | `#fallback-viz` absent |
| 7 | Task preferences visibly labeled as scoring biases | each row: "Effect: +3 live-routing preference · not a forced route" |
| 8 | Changing a task preference changes only the documented +3 preference | §10 — byte-identical config after round trip, no other field touched |
| 9 | Normal live routing remains D-004C1 | `liveRouteSelector: paragon-d-004c1`; request routed `scored.deterministic` |
| 10 | D-004D remains shadow-only | `mode: shadow`, `decidesExecution: false`; the recorded disagreement was reported, not applied |
| 11 | A normal request still completes | HTTP 200, content `ok` |
| 12 | Live and shadow winners displayed independently | live `cursor/gpt-5.6-luna-max` vs shadow `cursor/gpt-5.5-none-fast`, separate fields and separate plans |
| 13 | No extra provider call caused by the dashboard or shadow engine | 36 dashboard reads + 1 full shadow scenario evaluation → activity-log entries 12 → 12 (delta 0), provider CLI process count unchanged, catalog generation and `lastSuccessfulRefreshAt` unchanged |
| 14 | Hidden deprecated values preserved in config | §10 |
| 15 | Ports 10000 and 9420 unchanged | `tailscaleFunnelPort: 10000`, `tailscaleServePort: 9420`, dashboard 4117 |
| 16 | `/v1/models` unchanged | `['paragon', 'routerbot-local']` |
| 17 | Production checkout clean | `git status --short` → 0 files |
| 18 | Service active, `NRestarts=0` | active, `NRestarts=0`, PID 122137 |

The restart was verified behaviorally rather than trusted: the new PID's start
time (08:16:01) is after the deploy, and `/api/routing/providers` and
`/api/routing/status` went from 404 to 200.

### D-004C1 integrity re-check (directive stop condition)

```
forcing a catalog-rejected model (claude-mythos-5)
  → HTTP 400  routing.forcedModelNotEligible
forcing the unassessed provider (lmstudio)
  → HTTP 400  routing.providerPendingAssessment
registry: 232 auto-eligible rows, 1 reported-but-ineligible (the lmstudio
  pending-assessment row, which contributes nothing routable)
```

No regression. All 313 pre-existing tests remain green.

### A note on the transient state between merge and restart

`express.static` reads from disk per request, so between the production
fast-forward and the restart the **old process served the new front-end** while
lacking the new `/api/routing/providers` and `/api/routing/status` endpoints
(both 404). The dashboard rendered cards with avatars but with routing summaries
stuck on "loading…" and empty router panels. Live routing was unaffected
throughout — that is the old, unchanged code path. Any future deploy that
changes both `public/` and `src/` has the same window and should be restarted
promptly.

---

## 12. Tests

**352 total, up from 313 — 39 new.** Split across two files:

`test/dashboardRoutingTruth.test.js` (28) — surface contracts on the shipped
dashboard assets plus unit tests for the new pure modules. The absence
assertions target structural markers (element ids, `data-` hooks, endpoint
paths) rather than prose, so ordinary copy edits do not fail them while a
reintroduced control does.

`test/dashboardRoutingTruth.api.test.js` (11) — the claims that only hold
end-to-end.

Directive test items and where each is covered:

| Item | Covered by |
|---|---|
| 1. No normal model-selection dropdown | `1. provider cards no longer expose…` |
| 2. Cards show automatic per-request selection | `2. provider cards state that selection…` + `2b.` (API) |
| 3. Individual-model validation available | `3. individual-model validation remains…` |
| 4. Validation does not mutate `providerConfig.model` | `4.` (static, asserts no assignment exists) + `4b.` (API, asserts config unchanged after a real probe) |
| 5. Default-provider selector absent | `5.` |
| 6. Fallback-chain visualization absent | `6.` |
| 7. Fallback-chain editor absent | `7.` |
| 8, 9, 10. Unrelated save preserves the three deprecated fields | `8/9/10.` (API) — asserted in the response **and on disk**; fixture values differ from the defaults so a reset would be unmistakable |
| 11. Task preferences remain editable | `11/12/13.` |
| 12. Labeled as +3 scoring preferences | `11/12/13.` — asserts the label is read from the engine's reported weight |
| 13. Not labeled as fixed routes | `11/12/13.` |
| 14. Live router labeled D-004C1 | `14/15/16.` + `14b/15b/16b.` (API) |
| 15. Shadow router labeled D-004D | same |
| 16. Shadow clearly non-executing | same |
| 17. Latest live and shadow winners displayed | `17.` + `17b.` (API, after a real request) |
| 18. No UI path restores `fallback.staticDefault` | `18.` — also asserts the backend cannot emit the removed reason code and `buildProviderAttempts` has not returned |
| 19. No UI path bypasses catalog eligibility | `19.` |
| 20. D-004C1 integrity tests green | full suite; plus the live re-check above |
| 21. D-004D shadow tests green | full suite |
| 22. No removed-legacy-router references | `22.` — scoped to this directive's new files; the repo-wide walk already lives in `routingIntegrity.test.js` |

Additional coverage beyond the required list: TTL lapse leaving state history
intact while dropping eligibility; a non-chat model being excluded from the
eligible count; disabled versus pending-assessment providers; the
plan-versus-execution distinction (§6); avatar magic-byte rejection, provider-id
validation, size ceiling, upload/serve/delete round trip, and the assertion that
every bundled avatar path referenced by the dashboard exists on disk.

### Honest caveat on test stability

`routingIntegration.test.js`'s force-provider test failed once in 17 runs, while
extra preview servers were competing for the machine. It passed 16/16
afterwards, including 6 clean full-suite runs, and 6/6 at the base commit. That
test spawns the real provider CLIs on a fixed port, so it is load-sensitive. The
code this directive adds to that path is in-memory recording that runs after the
route is already fixed.

---

## 13. Remaining activation-related UI work

Deliberately **not** done here, and what a future directive would need:

1. **Schema removal for the three deprecated fields.** They remain in every
   persisted config. Removing them needs a tested config migration with a
   rollback path, and should follow D-004D activation rather than precede it.
2. **`routing.taskRoutes` as a shadow input.** The shadow expected-utility
   scorer does not consume the operator's task-provider preference
   (`consumesTaskProviderPreference: false`). If activation is meant to preserve
   operator intent, that preference needs an explicit representation in the
   utility model — otherwise activation silently discards it.
3. **An activation surface.** There is intentionally no way to promote D-004D
   from the dashboard. Whatever activation looks like, it needs its own gated
   control with a visible rollback, not a mode field.
4. **Shadow disagreement review UI.** The dashboard reports the latest
   disagreement and an aggregate rate. Evaluating activation will want the
   disagreement *distribution* — grouped by task profile and by transition —
   which `shadowStore.summary().topTransitions` already computes but no panel
   renders.
5. **Per-request token usage.** Unchanged from the D-004D evidence report and
   still the largest gap: PARAGON does not capture per-request token usage from
   any provider CLI, so `expectedReasoningTokens` runs on the ordinal prior for
   essentially every candidate. `estimatedQuotaBurn` remains a relative
   token-proportional scale, explicitly not any provider's actual allowance
   arithmetic.

---

## Verdict

**PARAGON_D004D1_DASHBOARD_ROUTING_TRUTH_COMPLETE**
