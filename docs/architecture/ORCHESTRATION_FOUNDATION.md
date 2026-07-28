# Orchestration Foundation (D-002)

Architecture reference for the `src/orchestration/` namespace introduced in
PARAGON-D-002. This describes what was built, not the future enforcement
system — see `PARAGON-D-003.md` for that proposal.

## Design principle

D-002 is **shadow-first by construction**: every module either records
observations or evaluates policy against those observations. Nothing in
`src/orchestration/` has a code path that can reject a request, mutate a
prompt, kill a process, or change provider/model selection. The single
integration seam into the existing request path
(`src/openaiApi.js`) only ever adds response headers and writes telemetry —
see `telemetry.js`'s `safely()` wrapper, which swallows any instrumentation
error so a storage failure can never turn into a client-visible failure.

## Module map

| Module | Responsibility |
|---|---|
| `ids.js` | Collision-resistant id generation/validation (`job_`, `sess_`, `run_`, `att_`, `ckpt_`, `dec_` prefixes) |
| `redaction.js` | Strips credential-shaped keys and bearer/`sk-` tokens from any record before it touches disk |
| `errorClassification.js` | Maps arbitrary provider/process errors to a bounded taxonomy + a separate bounded, redacted diagnostic |
| `schemas.js` | Versioned record shapes (`SCHEMA_VERSION = 1`) for job/session/run/attempt/checkpoint/decision |
| `eventStore.js` | Generic append-only JSONL store: serialized write queue, corrupt/partial-line isolation, atomic snapshots, retention-based compaction |
| `jobStore.js` / `sessionStore.js` / `runStore.js` / `attemptStore.js` / `checkpointStore.js` / `decisionStore.js` | Domain wrappers over `eventStore.js` |
| `correlation.js` | Reads `X-Paragon-*` headers, generates missing ids, never guesses session identity from IP |
| `contextEstimator.js` | Conservative char-heuristic token estimation (no tokenizer dependency) + bounded streaming response accumulator |
| `governorPolicy.js` | Default policy shape + `validatePolicy()` (rejects any `mode` other than `off`/`shadow`) |
| `shadowGovernor.js` | Pure functions: policy + observed values → decision objects. Never touches execution. |
| `duplication.js` | Conservative deterministic duplication signals (no LLM) |
| `usageLedger.js` | Pure aggregation of runs/sessions into the required context/duration bands |
| `telemetry.js` | The integration facade — owns all five stores, exposes `beginRequest`/`recordRoute`/`finishRequest` |
| `api.js` | Admin REST endpoints, mounted under the existing `/api` admin-auth middleware |

## Request lifecycle (as instrumented)

```
POST /v1/chat/completions
  → pickEnabledProvider() / buildProviderAttempts()   (unchanged)
  → orchestration.beginRequest(headers, body)
      → extractCorrelation()                          (correlation.js)
      → jobs.getOrCreate() / sessions.getOrCreate()
      → estimateRequestContext(body)                  (contextEstimator.js)
      → evaluateShadowGovernor(policy, ...)            (shadowGovernor.js)
      → decisions.record(...)                          (decisionStore.js, only if any fired)
      → runs.start(...)                                 (runStore.js)
      → returns { correlation, contextEstimate, run, responseHeaders }
  → res.set(responseHeaders)                            (X-Paragon-* headers)
  → orchestration.recordRoute(runId, {provider, ...})
  → runWithFallback(...) / streamCompletion(...)        (unchanged provider dispatch)
  → orchestration.finishRequest(runId, {success, provider, responseText, ...})
      → runs.finish() → jobs.recordUsage() → sessions.recordActivity()
```

Every orchestration call in this chain is wrapped in `safely()` in
`openaiApi.js` — an exception anywhere in the telemetry path is logged to
stderr and otherwise ignored; the actual `/v1` response is unaffected.

## What PARAGON can observe today

- Every `/v1/chat/completions` request: its estimated input size (char
  heuristic), which provider/model actually served it, whether that
  required a fallback, wall-clock duration, success/failure/timeout.
- Explicit parent/child run relationships **only when the caller supplies
  `X-Paragon-Parent-Run-ID`**. PARAGON has no other signal for
  "sub-agent-ness."
- Session-level aggregates (request count, duration, provider mix, max
  context) for whatever `X-Paragon-Session-ID` groups together — or a
  one-request implicit session when the header is absent.

## What PARAGON cannot observe (and honestly labels)

- **Provider-internal sub-agent activity.** If Claude Code, Codex, or
  Cursor Agent spawn their own internal sub-agents/tool calls during a
  single CLI invocation, PARAGON sees one opaque child process with one
  start/end time. It cannot decompose that into the provider's own
  planning/tool-call steps. Anything claiming otherwise would be a guess,
  which the directive explicitly forbids — this is why `agentRole:
  "unknown"` is the default rather than an inferred value, and why no
  metric anywhere claims to count provider-internal activity.
- **True token counts.** `contextEstimator.js` is a character-based
  heuristic (`chars / 3.5`), explicitly labeled `method: "char-heuristic"`,
  `isExact: false`, `confidence: "low"`. No authoritative tokenizer is
  wired in for any of the four built-in CLI providers.
- **Anything about a request that never carries a session header and isn't
  the very next request from the same never-correlated caller.** PARAGON
  does not fingerprint by IP, user agent, or timing to guess session
  membership — per the directive, "missing session identity must not be
  guessed."

## Storage

`data/orchestration/{jobs,sessions,runs,checkpoints,decisions}.jsonl`, one
file per record kind, append-only. `eventStore.js` keeps a full in-memory
index (`Map` keyed by id) loaded lazily on first access and updated on
every write — this is adequate for the append-only, single-process,
JSONL-scale (thousands, not millions, of records) that PARAGON operates
at; a real database was deliberately not introduced (per directive
section 6) because the audit found no reliability gap it would close at
this scale. Retention is enforced via `compactWithRetention(retentionDays)`,
which is **not** wired to a scheduler in D-002 — it exists as a callable
primitive; automatic periodic compaction is a D-003-or-later concern.

## Corrections applied in PARAGON-D-002A

An independent audit (`PARAGON-D-002A-AUDIT.md`) found and fixed several
defects in the original D-002 implementation before this branch was
considered mergeable:

1. **Per-attempt provider telemetry** — originally request-scoped only.
   `src/orchestration/attemptStore.js` + `schemas.js`'s `newAttempt()` now
   record one `attempt` per provider tried within a run's fallback
   sequence (start/end time, success, timeout, classified error, fallback
   reason, `followedByAnotherAttempt`, observable child PID). `RUN` = one
   incoming request; `ATTEMPT` = one provider try within it. See
   `GET /api/orchestration/runs/:id/attempts`.
2. **EPIPE crash** — `src/cli.js`'s `runProcess()` now attaches a
   `child.stdin.on("error", ...)` handler before writing, converting a
   write to an already-closed pipe into a normal rejected execution
   (`errorClassification: "BROKEN_PIPE"`) instead of an uncaught 'error'
   event that killed the whole process.
3. **Unbounded streaming memory** — `streamedText += chunk` is gone.
   `contextEstimator.js`'s `createBoundedResponseAccumulator()` tracks a
   running character count and content hash in O(1) space instead of
   retaining a duplicate copy of the full streamed response.
4. **Implicit sessions/jobs never closed** — an untagged request's
   one-request implicit session (and its job, once no sessions remain
   open) now close in `finishRequest()`. Explicit caller-supplied sessions
   are untouched. Active-session/active-job counts return to zero for
   ordinary untagged traffic instead of growing without bound.
5. **Duration terminology** — `sessionStore.js`'s `activeDurationMinutes()`
   actually computed wall-clock time despite its name. Split into
   `wallClockDurationMinutes()`, `activeProviderDurationMinutes()` (sum of
   real provider execution time), and `idleDurationMinutes()`. Governor
   session thresholds compare against wall-clock duration, matching the
   "sessions active 8+ hours" evidence the directive is built on.
6. **Duplication false positives** — `objectiveHash()` was hashing
   `messages[0].content`, commonly a shared system prompt. It now hashes
   only an explicit task-type header plus the *final* user-authored
   message, and returns `null` (no reliable hash) unless both are present.
7. **Subagent total-limit off-by-one** — `totalChildRunsInJob` excluded
   the run currently being evaluated, so with a limit of 4 the 5th child
   went unflagged. Fixed to include the current run in the count.
8. **Hardcoded enforcement-mode header** — `X-Paragon-Enforcement-Mode`
   said `"shadow"` unconditionally. It now reflects the actual configured
   `orchestration.mode`, and the master `orchestration.enabled` switch
   (previously read nowhere) now actually gates whether any telemetry is
   recorded at all.
9. **Run-id collision** — a client-supplied `X-Paragon-Run-ID` that
   collided with an existing, unrelated run would silently overwrite it
   (`eventStore.append()` overwrites by id). `beginRequest()` now detects
   the collision and mints a fresh id instead.
10. **Raw error messages as classification** — `errorClassification` used
    to be `error.message` verbatim. `errorClassification.js` now maps
    every failure to a bounded taxonomy (`AUTHENTICATION`, `RATE_LIMIT`,
    `TIMEOUT`, `PROCESS_EXIT`, `BROKEN_PIPE`, `NETWORK`,
    `MALFORMED_RESPONSE`, `CANCELLED`, `UNKNOWN`), with a separately
    bounded, redacted `errorDiagnostic` for human debugging.

## Known limitations (remaining after D-002A)

1. **`compactWithRetention` is unscheduled.** `retentionDays` is validated
   and stored in policy but nothing calls the compaction function on a
   timer. Wiring a periodic sweep (e.g., on server startup or a daily
   interval) is straightforward and left for the next iteration rather
   than adding a new background-timer subsystem inside this directive's
   scope.
2. **No tokenizer parity with real providers.** The char-heuristic
   estimator is deliberately conservative and simple; a provider-specific
   tokenizer (e.g., tiktoken for OpenAI-shaped models) would materially
   improve accuracy and could be added without changing the estimator's
   external shape (`estimatedInputTokens`, `method`, `confidence`).
3. **PID capture is best-effort and fire-and-forget.** `onSpawn` fires
   synchronously off the child process object but the resulting
   `recordAttemptProcessId()` write is not awaited by the request path
   (by design, to avoid adding latency) — under extreme load it is
   theoretically possible for an attempt's `processId` field to still be
   `null` if the process finishes and the attempt record is queried before
   that background write lands. This does not affect correctness of any
   other field.
