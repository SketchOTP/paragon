# Orchestration Observability (Operator Guide)

How to use PARAGON's D-002 shadow-mode observability: correlation headers,
the admin API, the dashboard panel, and how to read what it tells you.

**PARAGON is not enforcing anything described here.** Every threshold,
warning, and "would have" statement in this document and in the dashboard
is a shadow-mode observation — no request is ever blocked, no context is
truncated, no provider selection changes because of it.

## Correlation headers

Send these on `POST /v1/chat/completions` to link related requests
together. All are optional — a client that sends none of them still works
exactly as before, and gets a fresh generated job/run id and an implicit
one-request session per call.

| Header | Purpose | If omitted |
|---|---|---|
| `X-Paragon-Job-ID` | Groups everything under one higher-level objective | generated |
| `X-Paragon-Session-ID` | Groups requests that belong to the same working session | request becomes its own one-request session |
| `X-Paragon-Run-ID` | Identifies this specific request | generated |
| `X-Paragon-Parent-Run-ID` | Marks this request as a child of another run | treated as a root run |
| `X-Paragon-Agent-Role` | One of `root, planner, explorer, implementer, tester, reviewer, researcher, general-purpose, unknown` | `unknown` |
| `X-Paragon-Repository` | Free-text repository identifier, used for duplication signals | `null` |
| `X-Paragon-Task-Type` | Free-text task label, used for duplication signals | `null` |

Malformed ids (wrong shape, injected text) are silently discarded and
replaced — they never cause a 4xx. PARAGON echoes back the resolved ids in
response headers (`X-Paragon-Job-ID`, `X-Paragon-Session-ID`,
`X-Paragon-Run-ID`, `X-Paragon-Context-Estimate`,
`X-Paragon-Governor-Warnings`, `X-Paragon-Enforcement-Mode: shadow`) so a
caller can propagate the same session/parent-run id on its next request.

## Admin API

All endpoints below live under `/api/orchestration/*` and are protected by
the same admin auth as the rest of `/api` (API key, or loopback if
`allowLocalhost` applies).

| Endpoint | Purpose |
|---|---|
| `GET /status` | Active jobs/sessions/runs, max observed context, longest active session |
| `GET /jobs`, `GET /jobs/:id` | Job records (paginated via `?limit=&offset=`) |
| `GET /sessions`, `GET /sessions/:id` | Session records |
| `GET /runs`, `GET /runs/:id` | Run records; filter with `?sessionId=` or `?jobId=` |
| `GET /usage` | Full usage-ledger aggregation (provider, model, role, context band, duration band, success/failure, fallback, timeout) |
| `GET /decisions` | Recent shadow-governor decisions |
| `GET /duplication` | Conservative duplication signals across recorded runs |
| `GET /policy` / `PUT /policy` | Read/update the orchestration policy. `PUT` rejects any `mode` other than `off`/`shadow` with a 400. |
| `POST /checkpoints` | Manually record a checkpoint (objective, completed/remaining work, validation state) |

## Reading the dashboard

The **Orchestration Observability** panel (bottom of the dashboard) always
shows the shadow-mode banner. Its five groups map directly to the API:

- **Overview** — active jobs/sessions/runs, root-vs-child request split,
  max observed context, longest active session, current enforcement mode.
- **Context** — request counts per context band (`<32K` … `>150K`).
- **Sessions** — session counts per duration band (`<30m` … `8h+`).
- **Agents** — run counts per `agentRole`. A large `unknown` bucket means
  most callers aren't sending `X-Paragon-Agent-Role` — that's expected
  until clients start setting it.
- **Providers** — run counts per provider.
- **Governor** — the 10 most recent shadow decisions, each with the rule
  that fired and a plain-language explanation of what it would have
  proposed.

The panel polls `/api/orchestration/status`, `/usage`, and `/decisions`
every 30 seconds and has a manual Refresh button.

## Interpreting a shadow decision

Each decision record has:

- `policyRule` — e.g. `context.rollover`, `session.checkpoint`,
  `subagents.parallelLimit`.
- `observedValue` / `threshold` — what was actually seen vs. the configured
  line.
- `proposedAction` — `warn`, `propose_checkpoint`,
  `propose_session_rollover`, `would_block_request`, or
  `would_prevent_spawn`. None of these verbs describe something that
  happened — they describe what D-003's enforcement stage *would* do.
- `explanation` — a plain-English sentence, always ending with a
  reminder that shadow mode took no action.

## Privacy

Full prompt/response bodies are never persisted. Records store size
estimates, character counts, and bounded hashes (`objectiveHash`) —
never raw content. Any field whose key looks credential-shaped
(`apiKey`, `authorization`, `secret`, `password`, `credential`, or a
singular `*Token` spelling like `accessToken`) is redacted to
`[REDACTED]` before it is written to disk. Token-*count* fields
(`estimatedInputTokens`, etc.) are deliberately excluded from that
redaction — see `src/orchestration/redaction.js`.

## Synthetic replay

`test/orchestrationReplay.test.js` runs a fully deterministic, offline
scenario (no paid model calls) that reproduces the pathological workload
described in the D-002 directive: an 8.7-hour session, a request over the
150K-token absolute ceiling, two overlapping general-purpose child runs
with the same objective in the same repository, a provider fallback, and
a timeout. Run it directly to see the exact decisions PARAGON would have
proposed:

```bash
node --test test/orchestrationReplay.test.js
```

## Upgrade and rollback

- **Upgrade:** no manual action required. `orchestration` config merges in
  with documented defaults on first read (`mergeOrchestrationConfig` in
  `src/orchestration/governorPolicy.js`); existing `server`/`providers`/
  `routing` settings are untouched.
- **Rollback:** set `"orchestration": {"enabled": false}` (or delete
  `data/orchestration/*.jsonl`) — this stops new telemetry from being
  recorded. Nothing else in PARAGON depends on orchestration state, so
  routing/provider behavior is unaffected either way.

## Next stage

Enforcement (actually rolling over sessions, blocking oversized requests,
preventing runaway subagent spawns) is proposed as PARAGON-D-003 — see
`docs/architecture/PARAGON-D-003.md`. D-002 deliberately implements none
of it.
