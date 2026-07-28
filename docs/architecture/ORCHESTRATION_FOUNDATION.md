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
| `ids.js` | Collision-resistant id generation/validation (`job_`, `sess_`, `run_`, `ckpt_`, `dec_` prefixes) |
| `redaction.js` | Strips credential-shaped keys and bearer/`sk-` tokens from any record before it touches disk |
| `schemas.js` | Versioned record shapes (`SCHEMA_VERSION = 1`) for job/session/run/checkpoint/decision |
| `eventStore.js` | Generic append-only JSONL store: serialized write queue, corrupt/partial-line isolation, atomic snapshots, retention-based compaction |
| `jobStore.js` / `sessionStore.js` / `runStore.js` / `checkpointStore.js` / `decisionStore.js` | Domain wrappers over `eventStore.js` |
| `correlation.js` | Reads `X-Paragon-*` headers, generates missing ids, never guesses session identity from IP |
| `contextEstimator.js` | Conservative char-heuristic token estimation (no tokenizer dependency) |
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

## Known limitations

1. **Per-attempt provider telemetry is request-scoped, not attempt-scoped.**
   One HTTP request produces one `run` record. If the fallback chain tries
   three providers before one succeeds, the `run` record reflects the
   *final* provider/model and a `fallbackPosition` index, but does not
   store three separate timestamped attempts with individual child PIDs.
   Capturing that would require restructuring `runWithFallback()` in
   `openaiApi.js` to emit a sub-record per attempt — deferred as a
   non-blocking enhancement, since the directive's DATA MODELS section
   models `run` at the request level.
2. **Pre-existing crash bug discovered during D-002 testing, not fixed:**
   `src/cli.js`'s `runProcess()` calls `child.stdin.end(stdinText)` with no
   `error` handler on the child's stdin stream. If the child process exits
   before consuming a large stdin write (e.g., an unauthenticated CLI
   provider that exits immediately, fed a several-hundred-KB prompt), the
   write fails with `EPIPE` and crashes the entire Node process — this
   predates D-002 and does not relate to any code in `src/orchestration/`.
   Fixing it means touching provider execution code, which conflicts with
   D-002's constraint to make no provider/API behavior changes. Filing
   this as a discrete, separate fix is recommended before D-003, since
   D-003 will legitimately need to touch `cli.js` for enforcement anyway.
3. **`compactWithRetention` is unscheduled.** `retentionDays` is validated
   and stored in policy but nothing calls the compaction function on a
   timer. Wiring a periodic sweep (e.g., on server startup or a daily
   interval) is straightforward and left for the next iteration rather
   than adding a new background-timer subsystem inside this directive's
   scope.
4. **No tokenizer parity with real providers.** The char-heuristic
   estimator is deliberately conservative and simple; a provider-specific
   tokenizer (e.g., tiktoken for OpenAI-shaped models) would materially
   improve accuracy and could be added without changing the estimator's
   external shape (`estimatedInputTokens`, `method`, `confidence`).
