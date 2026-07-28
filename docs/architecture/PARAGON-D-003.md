# PARAGON-D-003 (proposed): Context Rollover and Session Enforcement

Status: **proposal only** — not implemented. Written at D-002 closeout as
required by D-002 section 22. This is scoped narrowly from evidence D-002
actually produced, not from aspiration.

## Precondition

D-003 does not start until the D-002 foundation has been independently
verified running against real traffic for long enough to answer one
question: **do the default shadow thresholds fire at reasonable
frequency, or are they miscalibrated?** Ship D-002, watch
`/api/orchestration/decisions` and the dashboard's Governor panel for at
least one real multi-hour session, and adjust `DEFAULT_ORCHESTRATION_CONFIG`
before writing any enforcement code. Enforcing against untuned thresholds
would immediately regress the workflows this whole effort is meant to
protect.

## Scope

D-003 converts a subset of D-002's `would_*`/`propose_*` decisions into
real actions, one policy family at a time, each independently toggleable:

1. **Context rollover enforcement** (`context.rollover` /
   `context.absoluteCeiling`) — when a request's estimated context crosses
   `rolloverTokens`, PARAGON triggers a **compact semantic handoff**: a
   checkpoint is generated (initially requiring a caller-supplied summary,
   since D-002 deliberately did not implement automatic model-generated
   checkpoint summarization — see D-002 section 15), and a fresh session
   id is issued and returned to the caller with a clear signal to switch
   to it. `context.absoluteCeiling` becomes an actual reject (`4xx`) only
   after rollover is proven to work, not before.
2. **Session rollover enforcement** (`session.rollover`) — same handoff
   mechanism, triggered by wall-clock/active duration instead of context
   size.
3. **Subagent limits** (`subagents.parallelLimit`,
   `subagents.totalPerJobLimit`, `subagents.recursiveChildrenAllowed`) —
   PARAGON refuses to start a new child run (via the correlation headers,
   not via any provider-internal mechanism it cannot see) once a limit is
   exceeded, returning a structured error the caller can retry after.
4. **Long-running external process detachment** — D-002's session-duration
   tracking explicitly separates active provider-execution time from
   wall-clock idle time (see `docs/architecture/ORCHESTRATION_BASELINE.md`
   → "Shutdown behavior" and D-002 section 8). D-003 should use that
   distinction to avoid rolling over a session that is legitimately
   waiting on a long external test run rather than actively burning
   context.
5. **Controlled failure recovery** — using the `loops.*` thresholds
   D-002 already defines but never evaluates (`repeatedFailureWarning`,
   `noProgressWarning`, `repeatedCommandWarning`): D-003 adds the
   evaluation logic (D-002 only shipped the config shape) and, once
   evaluated in shadow mode for a burn-in period, an actual circuit
   breaker.

## Explicitly not in D-003 either

Everything D-002 section "SCOPE — must not deliver" excludes remains
excluded in D-003 unless a future directive says otherwise: adaptive
provider selection, model scoring/benchmarking, automatic subagent
*spawning* (only limiting is in scope), worktree orchestration,
self-modifying prompts, and anything SmartRoute-derived.

## Required before D-003 can be marked complete

- `orchestration.mode` gains a real `enforce` value (D-002's
  `validatePolicy()` currently hard-rejects anything but `off`/`shadow` —
  that guard must be deliberately relaxed, not bypassed).
- Every enforcement action must remain independently toggleable back to
  shadow-only per policy family, so a miscalibrated threshold can be
  defused without a deploy.
- Fix the pre-existing `EPIPE` crash in `src/cli.js`'s `runProcess()`
  (documented in `ORCHESTRATION_FOUNDATION.md` → "Known limitations") —
  D-003 will be touching this file for subagent-limit enforcement anyway,
  so this is the natural place to close it, not before.
- A synthetic replay proving each enforcement action fires exactly once
  per violation and never double-fires across retries.
