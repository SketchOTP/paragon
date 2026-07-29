# PARAGON-D-004D: Capability-Aware, Reasoning-Cost-Aware, Outcome-Calibrated Routing (Shadow) — Evidence Report

Implementation worktree: `/home/sketch/Projects/paragon-d004d`, branch
`paragon-d004d-routing-intelligence`, from `origin/main` at `b172d6b`.
Merged as `681e8b2` (PR #15). Production
(`/home/sketch/Projects/paragon-production`, service `paragon.service`)
deployed at `681e8b2`, restarted 2026-07-29 19:38:00 EDT (PID 3685354).

**The live route selector is still PARAGON-D-004C1.** D-004D runs in shadow
mode only. Live activation is out of scope for this directive and is gated
behind a separate one.

## Central design rule

```
model identity  ≠  reasoning profile  ≠  speed profile
```

Ranking previously used `pricing.prompt` — price per million *input* tokens —
as the entire cost signal. A model at $2.50/M running `max` reasoning can
consume several times the total tokens of a nominally pricier model at `low`,
so the cheaper-per-million option is often the more expensive option *per
completed task*. And because Claude, Codex, Cursor and Antigravity are reached
through subscriptions, a dollar-only model treats them as free and
over-selects them until the allowance is gone.

## Phase 1 — reasoning-profile parsing rules

Parsing is **provider-keyed and evidence-based**. Each grammar was derived
from that provider's real live catalog, not assumed. Verified in production:

| Provider | Grammar | Effort tokens | Speed | Variant |
|---|---|---|---|---|
| cursor | `<base>[-thinking][-effort][-fast]` | none, minimal, low, medium, high, xhigh, max | fast | thinking |
| antigravity | `<base>-<effort>` | low, medium, high | — | — |
| codex | **none declared** | — | — | — |
| claude | **none declared** | — | — | — |

The asymmetry this exists for, confirmed on the live instance:

```
cursor/gpt-5.6-sol-max      -> canonical gpt-5.6-sol      effort=max      (modifier)
codex/gpt-5.1-codex-max     -> canonical gpt-5.1-codex-max effort=unknown (identity)
antigravity/gemini-3.1-pro-low -> canonical gemini-3.1-pro effort=low     (`pro` is identity)
claude/claude-opus-4-8      -> canonical claude-opus-4-8   effort=unknown
```

`max` is an execution modifier for cursor and part of the model identity for
codex. `flash` and `pro` are Google model identity and survive parsing. A
provider with no declared grammar keeps its complete id with
`reasoningEffort: unknown` — nothing is generically stripped, and
`profileParseSource` records which rule applied.

cursor's `thinking` is treated as a **model variant, not an effort**, because
cursor exposes both `claude-opus-5-high` and `claude-opus-5-thinking-high`;
collapsing them would merge two distinct executions.

Live effort distribution across the 232 assessed production models:

```
unknown 52 | high 45 | low 39 | medium 34 | xhigh 28 | max 23 | none 10 | minimal 1
```

## Phase 2 — reasoning-token and effective-cost model

`effectiveExpectedTokens = input + visible output + reasoning`. Cost is
reported as **two separate currencies** plus a combined figure:
`estimatedMonetaryCost`, `estimatedQuotaBurn`, `quotaScarcityPenalty`,
`estimatedTotalResourceCost`.

Reasoning effort uses evidence in the directive's order, with the ordinal
prior only as tier 5. The prior is asserted to be **monotonic only** — it is
expressed as a token *range* plus `reasoningBurnClass`,
`reasoningCostConfidence` and an uncertainty penalty, never as a precise
multiplier. Provider-returned or measured usage overrides it outright
(regression test 9 asserts a measured 42 tokens beats a much larger prior).

`unknown` reasoning burn does **not** default to zero — that assumption is
exactly what made max-effort models look cheap.

Subscription providers are never reported free: quota burn is proportional to
total tokens including reasoning, which is precisely what a `max` profile
inflates.

### Measured in production (same canonical model, two execution profiles)

Task: `implement a function`, 2,000 input tokens.

| Canonical model | Profile | Reasoning tokens | Range | Quota burn | Total resource cost | Expected utility |
|---|---|---|---|---|---|---|
| gpt-5.6-luna | `max` | 18,000 | 7,200–28,800 | 21.20 | 79.80 | −3.87 |
| gpt-5.6-luna | `low` | 1,050 | 300–1,800 | 4.25 | 12.00 | **39.22** |
| claude-sonnet-5 | `max` | 18,000 | 7,200–28,800 | 21.20 | 217.20 | −79.01 |
| claude-sonnet-5 | `low` | 1,050 | 300–1,800 | 4.25 | 30.75 | **24.40** |
| gpt-5.6-terra | `max` | 18,000 | 7,200–28,800 | 21.20 | 314.20 | −116.57 |
| gpt-5.6-terra | `low` | 1,050 | 300–1,800 | 4.25 | 43.00 | **28.22** |

`reasoningFit` is deliberately **two-sided**: over-reasoning a trivial task is
a cost defect and under-reasoning a hard task is a quality defect. Higher
reasoning is never treated as automatically better — unit test 7 proves `max`
loses a trivial task, and unit test 8 proves it can still win a
security-critical one.

## Phase 3 — capability evidence

Blanket `coding/tools/streaming: true` is replaced by a profile over the
directive's evidence hierarchy, with `capabilitySource`,
`capabilityConfidence` and `lastCapabilityValidationAt`. `unknown` never
satisfies a required capability.

Two decisions worth recording:

- **Structural capabilities.** Every builtin provider is invoked as a
  single-shot text completion with tools disabled (PARAGON-D-004B-R). So
  `toolCalls` is structurally `false` for them regardless of what the
  underlying model supports — PARAGON cannot surface it. Production proof:
  a tool-call request leaves **0 of 233** candidates eligible, all excluded
  as `routing.capabilityUnsupported.toolCalls`.
- **Catalog state is chat evidence.** A `validated` catalog entry means a real
  bounded *chat completion* probe succeeded, and `exposed` means the
  provider's own authoritative list returned it. Without reading that, the
  (correctly strict) gate excluded the entire registry — a bug the test suite
  caught before merge.

## Phase 4 — practical context model

`effectiveUsableContextWindow = min(model advertised, provider wrapper,
observed accepted) − output reserve − safety margin`, with
`contextEvidenceSource` and `contextConfidence`. Public documentation is
demoted to the **lowest** evidence tier. A wrapper limit can only ever lower
the ceiling, never raise it.

Production proof (900,000-token request, `contextBand: huge`):

```
eligible 15 of 233
routing.contextWindowExceeded          201
routing.unknownContextForLargeRequest   16
routing.providerPendingAssessment        1

example: claude/claude-opus-5 -> needs 904096 (input 900000 + output reserve 4096)
                                 > usable 185904
```

Output reserve counts against eligibility, and above the configured threshold
unknown context is **ineligible** rather than merely penalized (the old
scorer applied only a −3 point penalty).

## Phase 5 — multidimensional task profile

Ten deterministic dimensions replace the single first-regex-match label. Work
type is **scored**, not order-dependent, so "review this pull request diff and
explain the regression risk" resolves as `review` by weight of evidence rather
than by which pattern was declared first. No LLM call is involved.

Verified separation: `fix a simple typo in the readme` →
`trivial/minimal/economy`; `diagnose the root cause of this intermittent
production outage causing data loss across services` →
`complex/production/high` with `contextBand: large`.

## Phase 6 — outcome telemetry schema

Bounded aggregates in `data/routing-telemetry.json`, keyed by
provider / providerModelId / executionProfile / workType / complexity /
contextBand / outputContract, plus a model-wide fallback bucket. Fixed-width
latency histograms and EWMAs only — no per-request history, so the store
cannot grow with traffic (unit test 27: 500 recorded requests produce 2 keys
and under 4 KB).

Success probability is Laplace-smoothed toward 0.5 so a 1/1 model reports
~0.67 rather than 1.0 and cannot outrank a model with hundreds of stable
requests.

Production store after the proof run: **4 buckets, 3,735 bytes**, fields
limited to counters, token EWMAs, latency buckets and timestamps. No API key,
no prompt text, no response text, no authorization header — verified by grep.

## Phase 7 — benchmark canonicalization coverage

D-004C1's equality-only matching is preserved. Coverage is recovered by
matching the **canonical** model id produced by the Phase 1 provider grammars
— a different mechanism from the old substring guessing, because the modifiers
are removed by a declared grammar and the remaining comparison is still strict
equality.

Measured live across 232 assessed models:

| Match method | Count |
|---|---|
| `exact` | 35 |
| `exact_normalized` | 13 |
| `canonical_model` | 157 |
| `explicit_alias` | 0 |
| none | 27 |
| **matched** | **205 / 232** |

So coverage goes **227 (unsafe) → 48 (D-004C1, safe but sparse) → 205 (safe
and dense)**, with zero substring, family or nearest-name matches. A
`canonical_model` match is labeled distinctly and carries the note that the
benchmark describes the base model and does not imply the execution profile's
cost, latency or quality — and it contributes an uncertainty penalty for
exactly that reason.

`EXPLICIT_BENCHMARK_ALIASES` ships empty; an alias record requires
`providerModelId`, `canonicalModelId`, `benchmarkModelId`, `rationale`,
`reviewedAt`, `source` and `enabled`, and one missing provenance field is
rejected rather than silently accepted.

## Phases 8/10 — expected utility, tie-breaks, confidence

```
expectedUtility =
    probabilityOfSuccessfulCompletion * expectedTaskQuality
  - expectedTotalResourceCost
  - expectedLatencyPenalty
  - expectedQuotaScarcityPenalty
  - uncertaintyPenalty
  + reasoningFit
  + taskRoutePreference
```

Every component is returned separately, together with its evidence source.
Live example (winner `cursor/gpt-5.6-luna-medium-fast`):

```
components: probabilityOfSuccessfulCompletion, successSource, expectedTaskQuality,
  qualitySource, qualityTerm, expectedTotalResourceCost, costTerm,
  expectedLatencyPenalty, latencyTerm, latencySource, measuredLatencyP95Ms,
  expectedQuotaScarcityPenalty, quotaTerm, uncertaintyPenalty, uncertaintyTerm,
  uncertaintyReasons, reasoningFitAlignment, reasoningFitReason, reasoningFitTerm,
  taskRouteTerm

uncertaintyReasons: ["context capacity from public documentation only",
  "5 capability field(s) unknown", "no outcome telemetry",
  "reasoning-token consumption from ordinal prior",
  "benchmark describes the canonical base model, not this execution profile"]

weights: {qualityScale:100, resourceCostScale:0.5, latencyPenaltyScale:8,
  quotaScarcityScale:1, uncertaintyScale:20, reasoningFitScale:15,
  taskRoutePreferenceBonus:4}
```

Hard eligibility stays strictly separate from scoring — scoring never rescues
an inadmissible candidate.

Tie-breaks are explicit, in the directive's order, ending in a lexical anchor.
Registry insertion order is no longer a routing input; it previously was, as
an undocumented weight.

Confidence is evidence-based (`high`/`medium`/`low`/`only_eligible`/
`explicit_validated`) and **capped to `low` on a narrow margin**, because
confidence must describe the decision rather than the data quality. The live
example reported `low` with reason *"capped to low: winner and runner-up are
within 5% of each other, so the choice between them is not evidence-backed"* —
correct for a 0.51-point margin, where the old engine would have said
`scored`.

## Phase 9 — same-provider alternate-model fallback

The plan is provider-model-profile granular. Live example:

```
1. cursor/gpt-5.6-luna-medium-fast
2. cursor/gpt-5.6-luna-medium        (same-provider alternate)
3. claude/claude-opus-4-0
4. antigravity/gemini-3.1-pro-low
```

Failure classification: model-specific (`MODEL_NOT_FOUND`/`MODEL_REJECTED`/
`MODEL_UNAVAILABLE`) advances *within* the provider; provider-wide
(`AUTHENTICATION_FAILED`/`QUOTA_EXHAUSTED`/`ENTITLEMENT_REQUIRED`/
`PROVIDER_OFFLINE`/`CONFIGURATION_ERROR`) abandons the provider; transient
retries within budget. The same rejected profile is never retried inside one
request, and the D-004C1 attempt cap is preserved.

## Phase 11 — dashboard accuracy

The new "Routing Intelligence (shadow)" panel exposes scenario controls
(small/medium/large/custom context, streaming, tool calls, structured output,
reasoning demand, latency preference, cost sensitivity) and renders every
per-candidate field the directive lists, including expected input/output/
reasoning tokens, monetary cost, quota burn, success probability, quality,
uncertainty, expected utility, benchmark attribution, sample count and
exclusion reason.

`/api/routing-intelligence/scenario` calls the **same** `computeShadowRoute()`
the live shadow pass uses, with the same settings, so the panel cannot drift
from the engine. Production proof:

```
original ranking rows: 233 | replay rows: 233
identical ordering+exclusions: true
same winner: true (gpt-5.6-luna-medium-fast)
same utility: true
```

## Phase 12 — shadow deployment

Shadow computation runs *after* the live route is fixed and its headers are
set, so it structurally cannot influence the decision. It is pure computation
over already-loaded catalog, telemetry and benchmark data — no provider call,
no quota consumption. Any failure inside the engine is recorded and discarded.

Advisory-only headers: `X-Paragon-Shadow-Provider`,
`X-Paragon-Shadow-Model`, `X-Paragon-Shadow-Reasoning-Effort`,
`X-Paragon-Shadow-Agrees`.

## Live versus shadow disagreement

The first recorded production disagreement, on a trivial one-word request:

```
live:   cursor/gpt-5.6-luna-max      (D-004C1, no reasoning-cost model)
shadow: cursor/gpt-5.5-none-fast     (effort none, speed fast)
agrees: false   — reported, not applied
```

D-004C1 selected a `max` reasoning profile for `Reply with exactly one word:
ok`. The shadow engine selected effort `none`. On the Phase 2 figures above
that is roughly an 18,000-token versus 0-token reasoning difference for an
identical task — the concrete case this directive was written to address.

Shadow record contents (no prompt text present):

```json
{"workType":"unknown","complexity":"normal","risk":"normal",
 "reasoningDemand":"minimal","contextBand":"small","outputContract":"prose",
 "latencyPreference":"normal","qualityPreference":"balanced",
 "costSensitivity":"normal","estimatedInputTokens":9,
 "requiredCapabilities":["chatCompletions"]}
```

Records live in a bounded ring buffer (default 200); the buffer cannot grow
with traffic.

## Production proof

| # | Proof | Result |
|---|---|---|
| 1 | D-004C1 remains the only live route selector | `liveRouteSelector: paragon-d-004c1`; live header `scored.deterministic` |
| 2 | D-004D operates in shadow mode | `mode: shadow`, `enabled: true` |
| 3 | low/high/max profiles represented separately | 8 distinct effort levels across 232 models; `gpt-5.6-sol` appears as none/low/medium/high/xhigh/max × standard/fast |
| 4 | Canonical identity distinct from reasoning effort | all `gpt-5.6-sol-*` share `canonicalModelId: gpt-5.6-sol` |
| 5 | max-reasoning has higher expected resource cost | 3/3 sampled canonical models: 18,000 vs 1,050 reasoning tokens, 21.20 vs 4.25 quota |
| 6 | No unsupported generic suffix stripping | `codex/gpt-5.1-codex-max` keeps its id, effort `unknown`; only cursor+antigravity have grammars |
| 7 | Large-context scenarios use practical capacity | 900k request: 201 context-exceeded + 16 unknown-context exclusions, with explicit token arithmetic |
| 8 | Dashboard custom-context result equals shadow result | identical ordering, exclusions, winner and utility |
| 9 | Capability requirements exclude incompatible candidates | tool-call request: 0/233 eligible, 232 × `routing.capabilityUnsupported.toolCalls` |
| 10 | Same-provider fallback plans generated | plan contains 2 cursor attempts, second flagged `alternateForProvider` |
| 11 | Utility components and confidence inspectable | 20 named components + uncertainty reasons + exposed weights |
| 12 | Shadow causes no additional provider call | shadow records 0→1 for one request; response answered by the D-004C1 chain |
| 13 | No prompt, response, credential or API key persisted | telemetry 3,735 B, 4 buckets, grep-verified clean; shadow record carries no prompt |
| 14 | Production API and dashboard unchanged | `/v1/models` lists `paragon`; ports 10000/9420 listening |
| 15 | Production checkout clean | `git status --short` empty at `681e8b2` |
| 16 | Service stable | `ActiveState=active`, `SubState=running`, `NRestarts=0` |

### D-004C1 integrity regression check

Re-verified live after deployment:

- Registry: 233 rows (claude 16, codex 15, cursor 193, antigravity 8,
  lmstudio 1 pending), **0 ineligible rows**.
- Forced rejected model (`claude-mythos-5`) → **HTTP 400**.
- Forced unassessed provider (`lmstudio`) → **HTTP 400**.
- All 262 pre-existing tests green, including every D-004C1 integrity test.

## Tests

**313 passing** (was 262); `npm run check` and `git diff --check` green.
41 new unit tests (`test/routingIntelligence.test.js`) plus 10 HTTP tests
(`test/routingIntelligence.api.test.js`) covering all 30 directive-required
cases, including the invocation-counting fixture that asserts exactly one
provider call per request.

### Two bugs the tests caught before merge

1. **The capability gate excluded the entire registry.** Requiring
   `chatCompletions === true` was correct, but catalog `validated` state was
   not being read as chat evidence — even though catalog validation *is* a
   chat-completion probe. Every candidate read `unknown` and was gated out.
2. **Confidence reported `medium` on a near-tie.** A 0.1-point lead out of 100
   is an essentially arbitrary choice, yet well-characterized candidates were
   lifting it to `medium`. Fixed with the narrow-margin cap described above —
   a modeling correction, not a test accommodation.

## Remaining activation requirements

Live cutover is **out of scope** here. Before an activation directive should
authorize it:

1. Accumulate enough outcome telemetry that measured evidence — not priors —
   drives `probabilityOfSuccessfulCompletion`, quality and latency. Today
   almost every candidate reports `no outcome telemetry` and
   `reasoning-token consumption from ordinal prior`.
2. Replace the reasoning-token ordinal prior with provider-returned usage.
   PARAGON does not currently capture per-request token usage from any
   provider CLI; that plumbing does not exist yet and is the single largest
   gap between the current cost model and a real one.
3. Calibrate `UTILITY_WEIGHTS` against recorded live-vs-shadow disagreements
   rather than the readable starting values shipped here.
4. Populate reviewed `canonicalAliasMappings` for the 27 still-unmatched
   models, and reviewed `contextOverrides` for models whose capacity is only
   `public_documentation`.
5. Establish real subscription accounting. `estimatedQuotaBurn` is currently a
   token-proportional relative scale, explicitly not a claim about any
   provider's actual allowance arithmetic; `quotaScarcity` defaults to 0.
6. Verify provider wrapper context limits empirically —
   `PROVIDER_WRAPPER_CONTEXT` is all `null` (no known ceiling), which is
   honest but unmeasured.

## Final verdict

**PARAGON_D004D_ROUTING_INTELLIGENCE_SHADOW_COMPLETE**

Model identity, reasoning profile and speed profile are now separated by
provider-declared grammars with no generic stripping. Reasoning effort is
priced as a distinct dimension in both tokens and subscription allowance, so
a `max` profile carries its real cost and a cheaper-per-million model can no
longer be selected as the cheaper option when it is not. Capability, practical
context, and catalog eligibility are hard gates; expected utility is fully
decomposed and inspectable; tie-breaks are explicit; confidence reflects the
decision rather than the data. Benchmark coverage was restored from 48 to 205
of 232 models without reintroducing a single substring match. All of it runs
in shadow, verified in production to change neither the route nor the number
of provider calls, with every PARAGON-D-004C1 integrity guarantee re-checked
live and intact.
