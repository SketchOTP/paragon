# Orchestration Baseline (Cold-Start Audit)

This document describes PARAGON's system **as it exists today**, at commit
`10c64eb` (the clean PARAGON rename, v0.2.3), before any D-002 orchestration
work. It is a factual audit, not a design proposal.

## Request ingress path

Single Express app (`src/server.js`). `express.json({ limit: "5mb" })` parses
bodies; `express.static` serves `public/`. No request-scoped context object,
no request ID, no middleware-level timing.

## OpenAI-compatible endpoints

`src/openaiApi.js` registers two routes under `/v1`, gated by
`createAuthMiddleware(getConfig, { allowLocalhost: false })`:

- `GET /v1/models` — returns `config.server.exposedModel` plus the legacy
  `routerbot-local` alias. Stateless, no telemetry beyond one log line.
- `POST /v1/chat/completions` — the only generation endpoint. Streaming and
  non-streaming share one code path (`runWithFallback`). No `tools`/function
  schemas are read from the request body today — `messagesToPrompt` only
  serializes `messages[].role`/`.content`. There is no per-request `usage`
  accounting; `chatCompletion()` always returns
  `{prompt_tokens:0, completion_tokens:0, total_tokens:0}`.

## Streaming path

`streamCompletion()` in `openaiApi.js` writes raw SSE (`data: {...}\n\n`)
directly on the Express `res`. It reuses `runWithFallback` with an `onChunk`
callback. No abstraction between transport and provider execution exists —
adding instrumentation here means wrapping `runWithFallback`, not the
transport.

## Provider-selection path

1. `classifyTask(prompt)` (`src/taskClassifier.js`) — keyword classifier,
   synchronous, no model call.
2. `config.routing.taskRoutes[task] ?? config.routing.defaultProvider`.
3. `pickEnabledProvider()` falls back to the first enabled provider if the
   routed one is disabled.
4. `buildProviderAttempts()` (`src/providerFallback.js`) expands into the
   ordered attempt list (primary + fallback chain, deduplicated).

This is a **stateless, per-request decision** — there is no session
concept, no memory of prior requests, no correlation between two calls that
"belong together."

## Provider invocation lifecycle

Two provider kinds, dispatched from `runProvider()` in `src/cli.js`:

- **CLI providers** (`runProcess` in `cli.js`): `child_process.spawn`,
  stdin-fed prompt, stdout/stderr accumulated in memory, hard timeout via
  `setTimeout` + `SIGTERM`. Exit code 0 → resolve, non-zero → reject with
  `error.stdout`/`.stderr`/`.code` attached. No child PID is surfaced to
  callers; `addLog()` records a one-line summary (`exited N; stdout X
  chars; stderr Y chars`) but not start time, duration, or the PID.
- **HTTP providers** (`runHttpProvider`/`streamHttpResponse` in
  `src/httpProvider.js`): plain `fetch` to `${baseUrl}/chat/completions`,
  `AbortSignal.timeout`, and for streaming, manual SSE line-parsing that
  re-emits `delta.content` chunks. No response-size accounting beyond a log
  line character count.

Neither path retains provider responses beyond the single log line
character count — full prompt/response bodies are never persisted.

## CLI child-process lifecycle

Every CLI invocation (`runProcess`) is a fresh `spawn` with no pooling, no
concurrency limiting, and no parent/child tracking. Auth flows
(`startCliAuth`, `startGeminiAuth`) track subprocesses in a module-level
`authProcesses` Map keyed by provider name (one at a time per provider) —
this is the *only* existing "process registry" in the codebase, and it is
scoped to auth, not completions.

## Fallback lifecycle

`runWithFallback()` in `openaiApi.js` iterates `attempts` sequentially,
logging `error`/`fallback` entries via `addLog()` on each transition. The
final `CLIENT_ERROR_MESSAGE` (from `providerFallback.js`) is the only thing
returned to the client on total failure — the specific per-attempt errors
are only visible in the activity log, not in the API response.

## Existing activity logging

`src/logStore.js` — an in-memory ring buffer (`maxEntries = 200`), no
persistence, no disk write, cleared on process restart. Entries:
`{id, at, type, provider, level, message}`. `type` is a free-form string
(`request`, `route`, `completion`, `status`, `models`, `auth`,
`auth-complete`, `fallback`, `error`). Consumed by `GET /api/logs` (full
snapshot) and `GET /api/logs/stream` (SSE tail via `subscribeLogs`). This is
the closest existing thing to telemetry, and it is what orchestration
instrumentation must sit *alongside*, not replace — the activity log is a
human-facing feed, not a queryable structured record.

## Configuration loading

Single loader: `readConfig()`/`writeConfig()` in `src/configStore.js`.
`dataDir` is hardcoded to `path.resolve(process.cwd(), "data")` (no
profile/HOME concept — this is a from-scratch Node app, not built on the
Hermes-Agent `get_hermes_home()` convention referenced in the repo's
`CLAUDE.md`, which documents a *different* project). Config merge
(`mergeConfig`) is a shallow-plus-nested-object merge; `migrateToParagon()`
(`src/configMigrate.js`) runs on every read/write and is idempotent,
gated by `configVersion`. Env overrides (`applyEnvOverrides`) apply after
file merge and take precedence. There is exactly one config file:
`data/config.json`, never committed.

## Dashboard structure

Static single-page app: `public/index.html` + `public/app.js` (vanilla ES
module, no framework) + `public/styles.css`. Sections: hero/metrics,
provider cards, routing panel (`#routes`), activity log panel (`#logs`).
State is fetched from `/api/config`, `/api/status`, `/api/logs` on load and
polled/streamed thereafter. There is no existing notion of "sections" as a
plugin surface — each panel is hand-wired DOM in `app.js`. Any new
"Orchestration Observability" section is additive: new DOM section + new
fetch calls against new `/api/orchestration/*` endpoints.

## Test structure

`node --test` (Node's built-in runner, no Jest/Mocha). Files under `test/`
map loosely to `src/` modules (`auth.test.js`, `authSessions.test.js`,
`models.test.js`, `paragonMigration.test.js`, `release.test.js`). 33 tests
total at baseline. No test currently boots the Express app or hits `/v1`
end-to-end — `openaiApi.js`/`server.js` have zero direct test coverage
today. This means D-002's integration tests will be the *first* tests that
exercise the live HTTP surface, which is worth calling out as pre-existing
risk, not something introduced by this work.

## Data-directory behavior

`data/` is created lazily (`fs.mkdir(dataDir, { recursive: true })`) on
first write. Nothing else lives there today except `config.json`. This is
the natural home for `data/orchestration/` per the directive.

## Shutdown behavior

None. No `SIGTERM`/`SIGINT` handler exists anywhere in the codebase.
`app.listen()` runs until the process is killed; in-flight child processes
spawned by `runProcess` are not reaped on shutdown. Any write-queue for
orchestration JSONL files must be safe against an unclean process exit
(crash-tolerant recovery is explicitly required by the directive, and this
audit confirms it is not optional — nothing today guarantees a clean
flush).

## Concurrency behavior

Express's default (one process, event-loop concurrency; each request
handler is independently async). No global request counter, no in-flight
request registry, no concurrency limiting on provider calls — two
overlapping `/v1/chat/completions` requests today run fully independently
with no shared state at all. This is exactly the gap D-002 fills: there is
currently no way to observe "N requests are in flight" or "these two
requests are related," which is why session/run correlation must be
introduced via explicit headers rather than inferred from process state.

## Summary of integration points for D-002

| Concern | Where to instrument |
|---|---|
| Request correlation (read headers, generate IDs, write response headers) | `openaiApi.js`, both routes |
| Context estimation (pre-dispatch) | `openaiApi.js`, before `runWithFallback` |
| Provider execution telemetry | `cli.js` (`runProcess`), `httpProvider.js` (`runHttpProvider`/`streamHttpResponse`) — both already funnel through `runProvider()` in `cli.js`, so a single wrapper there covers both provider kinds |
| Session/job persistence | New `src/orchestration/*` modules, independent of `configStore.js` |
| Admin API | New routes in `server.js`, reusing the existing `adminAuth` middleware already mounted at `/api` |
| Dashboard | Additive section in `public/index.html`/`app.js`/`styles.css` |
