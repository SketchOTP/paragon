# PARAGON-D-002A Independent Audit

Code-first audit of PR #3 (`paragon-d002-orchestration-foundation` @
`fdc1d96`), performed before accepting the corrective directive's fixes,
covering request integration, streaming lifecycle, attempt lifecycle,
session closure, store concurrency, redaction, and API aggregation. Each
finding below states what the code actually did (not what tests claimed),
why it mattered, and how it was fixed. This is the record of the audit
itself — see `ORCHESTRATION_FOUNDATION.md` → "Corrections applied in
PARAGON-D-002A" for the post-fix architecture summary.

## Method

Read every file in `src/orchestration/`, `src/openaiApi.js`, and
`src/cli.js` line by line against the corrective directive's 11 numbered
requirements, independent of the D-002 test suite (which, correctly,
didn't catch most of these — the tests exercised the code as written, and
the code as written had the defects). Findings were then reproduced with
either a targeted unit test or a live server request before being
accepted as real.

## Findings

### F1 — Fallback attempts collapsed into one run record (CRITICAL)

**Location:** `src/openaiApi.js`, `runWithFallback()` (pre-fix).

`runWithFallback` iterated `attempts` and only the caller (`beginRequest`/
`finishRequest`) ever touched orchestration state — once, for the whole
loop. A request that tried codex, failed, then tried cursor and succeeded
produced a single `run` record whose `provider` field said `"cursor"` and
whose `durationMs` covered *both* attempts combined. There was no way to
answer "which provider actually failed and why" — the exact question
D-002's mission statement opens with.

**Reproduced:** unit test `beginAttempt/finishAttempt record distinct
attempt records`, and confirmed live — a real request against an
unauthenticated codex + cursor chain now produces two `attempt` records
with independently correct `durationMs`, `errorClassification`, and
`processId` (398894, 399028 in the live repro — two distinct real PIDs).

**Fix:** F1 in `ORCHESTRATION_FOUNDATION.md` corrections list (`attemptStore.js`,
`schemas.js#newAttempt`, `telemetry.js#beginAttempt/finishAttempt`,
`openaiApi.js#runWithFallback`).

### F2 — Unhandled EPIPE crashes the whole server (CRITICAL)

**Location:** `src/cli.js`, `runProcess()` (pre-fix), line ~598.

`child.stdin.end(stdinText)` had no error listener on `child.stdin`. Node
emits `'error'` on a writable stream when a write lands on an
already-closed pipe; with no listener, that's an uncaught exception that
terminates the process. Reproduced deterministically: spawning a fixture
process that exits immediately, then writing a 2MB string to its stdin,
crashed the whole test runner process before the fix and does not after.
Reproduced again against the live server with a real 700KB prompt against
an unauthenticated `cursor-agent` — `errorClassification: "BROKEN_PIPE"`,
server still answers `/health` immediately after.

This sat in exactly the code path (`src/cli.js`) that D-003's subagent
limiting will need to touch, so leaving it unfixed would have compounded.

**Fix:** `child.stdin.on("error", ...)` attached before every write;
converts EPIPE into a normal rejected execution.

### F3 — Full streamed response buffered in telemetry (HIGH)

**Location:** `src/openaiApi.js`, `streamCompletion()` (pre-fix), line 236.

`let streamedText = ""; ... streamedText += chunk;` retained a second
complete copy of every streamed response purely so `finishRequest` could
call `estimateResponseSize(streamedText)` at the end. For PARAGON's stated
high-volume use case (up to ~40K edited lines/day, 8+ hour sessions), this
is an unbounded-per-request memory cost with no correctness benefit — the
SSE chunks are already forwarded to the client as they arrive and don't
need to be re-read.

**Fix:** `createBoundedResponseAccumulator()` — O(1) running character
count + streaming SHA-256 hash, finalized once at the end.

### F4 — Implicit sessions/jobs never close (HIGH)

**Location:** `src/orchestration/telemetry.js`, `finishRequest()` (pre-fix).

`extractCorrelation()` correctly marked a session as
`sessionIsImplicit: true` when no `X-Paragon-Session-ID` header was sent,
but nothing downstream ever read that flag after `beginRequest`. Every
untagged request — the *default* case for any client that hasn't adopted
the new headers — created a session and job that stayed `status: "active"`
forever. `GET /api/orchestration/status`'s `activeSessions`/`activeJobs`
counts (and the dashboard Overview cards built on them) would grow
monotonically under ordinary traffic and never reflect reality.

**Reproduced:** `status aggregation returns to zero active sessions/jobs
after implicit traffic completes` — before the fix this assertion failed
(counts stayed at 3/3 instead of returning to 0/0); confirmed live via the
smoke-test request, `activeSessions: 0` / `activeJobs: 0` immediately
after the request completed.

**Fix:** `finishRequest()` now closes an implicit session and, if that was
the job's last active session, closes the job too. Explicit
caller-supplied sessions are untouched — verified by a dedicated test.

### F5 — "Active duration" was actually wall-clock duration (MEDIUM)

**Location:** `src/orchestration/sessionStore.js`,
`activeDurationMinutes()` (pre-fix).

The function computed `(now - session.startTime) / 60000` — wall-clock
elapsed time — despite the persisted field `session.activeDurationMs`
already correctly accumulating real provider-execution time via
`recordActivity`'s `activeDurationDeltaMs`. The function name and the
stored field described two different things, and only the (correctly
computed) wall-clock number was ever surfaced to the governor or the API.
This happened to produce the *right* behavior for the long-session
threshold (which should use wall-clock time, matching "sessions active
for 8+ hours" evidence) but for the wrong reason, and gave no way to ever
report the two numbers separately — which the directive explicitly
requires ("state explicitly whether each threshold uses wall-clock or
active provider duration").

**Fix:** split into `wallClockDurationMinutes()`,
`activeProviderDurationMinutes()`, `idleDurationMinutes()`; governor
continues to compare against wall-clock, now by explicit design rather
than accidental naming.

### F6 — Objective hash sourced from `messages[0]` (HIGH — false-positive risk)

**Location:** `src/orchestration/telemetry.js`, `beginRequest()` (pre-fix),
`objectiveHash(correlation.taskType, body?.messages?.[0]?.content)`.

`messages[0]` is, in virtually every real client, the system prompt — the
part of the request *least* likely to vary between unrelated child runs
and most likely to be identical across every subagent in a session. Under
the pre-fix code, two children with completely different objectives but
the same system prompt, same session, same repository, and any temporal
overlap would be classified `CONFIRMED_DUPLICATION` — the strongest,
most action-implying label the system produces, for a query
(deduplication) whose entire design goal is to be conservative.

**Reproduced:** `a shared system prompt across children with different
objectives is not treated as a duplicate` — before the fix, this
configuration produced 1 `CONFIRMED_DUPLICATION` signal; the fix drops it
to 0 while `two children with the same task type, same final user
message, ...` (a genuine duplicate) still correctly produces exactly 1.

**Fix:** `objectiveHash()` now only ever hashes an explicit
`X-Paragon-Task-Type` header plus the *final* user-authored message, and
returns `null` — no reliable hash — if either is absent, rather than
falling back to guessing from the first message.

### F7 — Total-child-run limit off by one (MEDIUM)

**Location:** `src/orchestration/telemetry.js`, `beginRequest()` (pre-fix):
`totalChildRunsInJob = runs.byJob(jobId).filter(r => r.parentRunId).length`.

This counted children *already persisted* before the current request was
added to the store — it never included the run currently being created.
`evaluateSubagents` fires on `totalChildRunsInJob > limit`; with the
default limit of 4, the 5th child arrived with `totalChildRunsInJob = 4`
(the four prior children), `4 > 4` is false, and the violation went
unflagged. The 6th child would have been the first to trigger it — one
child later than the configured limit actually allows.

**Reproduced:** `the total-child-run limit fires on the 5th child, not the
4th` — failed pre-fix (5th child produced no decision), passes post-fix.

**Fix:** count includes `+ 1` for the run being created.

### F8 — Enforcement-mode header hardcoded to "shadow" (MEDIUM)

**Location:** `src/orchestration/correlation.js`,
`correlationResponseHeaders()` (pre-fix): `"X-Paragon-Enforcement-Mode":
"shadow"` as a string literal, independent of the actual configured
`orchestration.mode`. Separately, `config.orchestration.enabled` was read
nowhere in `openaiApi.js` — the master switch had no effect; orchestration
ran unconditionally whenever the `orchestration` runtime object existed.

**Fix:** header now takes `mode` as a parameter, sourced from
`getPolicy().mode` at the point of use; `openaiApi.js` now gates telemetry
creation on `config.orchestration.enabled` before calling `beginRequest`
at all.

### F9 — Client-supplied run id could overwrite an unrelated run (HIGH — data integrity)

**Location:** `src/orchestration/correlation.js` /
`src/orchestration/telemetry.js` (pre-fix). `acceptOrGenerateId("run",
suppliedRunId)` only validated the *shape* of a supplied id, not whether
it already belonged to a different run. `eventStore.append()` is,
by design, an upsert-by-id (`records.set(id, record)`) — that's exactly
what lets `runs.update()`/`runs.finish()` work. But it also means a client
sending a stale or maliciously reused `X-Paragon-Run-ID` matching another
tenant's in-flight run would silently overwrite that run's record.

**Reproduced:** `a client-supplied run id colliding with an existing
unrelated run does not overwrite it` — asserts the pre-existing record is
byte-for-byte unchanged after a colliding request.

**Fix:** `beginRequest()` checks `runs.get(runId)` before use; on
collision, mints a fresh id via `generateId("run")` instead.

### F10 — Raw error messages stored as "classification" (MEDIUM)

**Location:** `src/openaiApi.js` (pre-fix): `errorClassification:
error.message`. This stored unbounded, unredacted, non-normalized text
in a field the API/dashboard treat as a categorical value — `GET
/api/orchestration/usage` and any future aggregation by failure type had
no stable set of values to group on, and raw error text risks leaking
provider-internal detail (stack traces, file paths, occasionally
credentials embedded in CLI error output).

**Fix:** `errorClassification.js#classifyError()` maps to a fixed 9-value
taxonomy; `boundedDiagnostic()` provides a separate, redacted,
length-capped field for human debugging.

## Storage/concurrency audit (directive item 11)

- **Simultaneous writes** — `eventStore.js`'s `writeQueue` is a single
  promise chain per store instance; verified with 50 concurrent
  `append()` calls to one store, all 50 persisted with correct content
  and no interleaving corruption.
- **Restart during append / partial final line** — pre-existing coverage
  in `orchestrationUnit.test.js` (unchanged, still passing): a truncated
  final JSONL line is skipped, not fatal, and does not lose earlier lines.
- **Corrupt middle line** — pre-existing coverage: isolated, surrounding
  records unaffected.
- **Retention compaction** — pre-existing coverage:
  `compactWithRetention()` drops only records past the window.
- **Duplicate supplied run IDs** — new coverage, see F9 above.
- **Duplicate request retries** — a retried request that reuses the same
  (now-finished) run id is, by F9's fix, treated identically to any other
  collision: a fresh run id is minted rather than the finished record
  being overwritten. This was verified as a direct consequence of the F9
  test rather than a separate scenario, since the two cases are
  mechanically identical from the store's point of view.
- **Store initialization races** — `createEventStore`'s lazy `ensureLoaded()`
  loads synchronously on first access (`fs.readFileSync`), so there is no
  async race between two early calls on the same process; multi-process
  access to the same JSONL file was out of scope (PARAGON runs as a
  single process, per the D-002 baseline audit).
- **Server restart, full cycle** — `server restart (fresh runtime over the
  same data dir) still sees closed implicit sessions as closed` —
  constructs two independent `createOrchestrationRuntime` instances
  against the same `dataDir` to simulate a process restart; the second
  instance correctly loads the first's closed-session state from disk.

## Not re-litigated

The following D-002 design decisions were reviewed and found sound on
re-audit, so were left unchanged: the append-only JSONL storage format
itself (no DB needed at this scale — confirmed by the concurrency tests
above), the char-heuristic context estimator's honesty about being
inexact, the `unknown` default for unobservable agent roles, and the
overall shadow-only architecture (nothing added in D-002A introduces any
new code path capable of blocking, truncating, or rerouting a request).
