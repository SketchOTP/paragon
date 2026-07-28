# PARAGON-D-002C: Clean Production Cutover — Preparation Report

Everything in this document was performed as the `sketch` user with no
sudo access (`sudo -n true` fails: "interactive authentication is
required" — this sandbox has no passwordless sudo). All steps that don't
require root are complete and validated below. The steps that do require
root are written out as an explicit runbook the operator must run
themselves: `/home/sketch/paragon-cutover-backup/20260728_093259/STAGE4_CUTOVER_RUNBOOK.sh`.

## Security incident status

During PARAGON-D-002B Stage 4A discovery, a command inspecting
`data/config.json`'s structure printed the full `server.tunnels` object,
including a real ngrok auth token, into conversational output. It was
never written to any file or committed. **Operator confirmed 2026-07-28:
the token has been revoked and ngrok is no longer in use.** The migrated
config for this cutover already excludes `server.tunnels` entirely (see
Configuration migration, below) — ngrok plays no role in the clean
deployment.

## What was verified read-only (no state changed)

- `sudo -n true` → fails → no passwordless sudo in this session.
- `/etc/systemd/system/routerbot.service` and `/etc/routerbot/environment`
  are both world-readable (no secrets in the environment file — only
  `HOME`, `PATH`, `NODE_ENV`).
- Live `data/config.json` inspected with a redaction filter (never
  printed unredacted) — full structure captured in
  `config.json.redacted.json` in the backup dir.
- `tailscale serve status` confirms Funnel `:10000` proxies directly to
  `127.0.0.1:4117` — the cutover does **not** need to touch the Funnel
  mapping's target, only briefly toggle it off/on around the swap, since
  the new service will also bind `127.0.0.1:4117`.

## Backups (outside the new production checkout)

`/home/sketch/paragon-cutover-backup/20260728_093259/`:

| File | Contents |
|---|---|
| `01_state_capture.txt` | systemctl status, ss, ps, live git HEAD, tailscale status — all at capture time |
| `routerbot.service.bak` | Exact copy of the live unit file |
| `environment.keys_only.txt` | `/etc/routerbot/environment` with values redacted (no secrets were present) |
| `config.json.redacted.json` | Full live config structure, all key-value pairs whose key name looks credential-shaped redacted |
| `data_dir_inventory.txt` | `ls -la` of `data/` — names/sizes/mtimes only, proves SmartRoute artifacts and their last-write times |
| `journal_tail.txt` | Last 200 journal lines for `routerbot.service`; scanned for credential-shaped strings — clean |
| `smartroute_state_snapshot.tar.gz` | Real (unredacted) tarball of `config.json` + SmartRoute canary/guard state + stale log, for rollback purposes. **Never printed to any output — file only.** |
| `STAGE4_CUTOVER_RUNBOOK.sh` | The privileged cutover script — see below |

The live checkout at `/home/sketch/Projects/RouterBot` itself is untouched
and remains the primary forensic copy of the contaminated deployment —
nothing here duplicates its ~5MB of model/pricing/benchmark caches, since
directive item "preserve historical contaminated files as evidence" is
satisfied by leaving that worktree alone (on the do-not-touch list).

## Clean production checkout

- `/home/sketch/Projects/paragon-production` — new worktree, detached
  HEAD at `fcd73f061cace6999b78300034008677b2b45da7`.
- `git status --porcelain` clean, `src/smartRoute/` absent, neither
  `08a7aa3` nor `ec4bd30` is an ancestor.
- `npm test` → 94/94 passing. `npm run check` → passes. `git diff --check`
  → clean.

## Configuration migration

Built via an explicit allowlist (not a wholesale copy) applied to the
real `mergeConfig(defaultConfig, incoming)` from clean main's own
`configStore.js` — not hand-rolled JSON, so the result is guaranteed
schema-valid. The `incoming` override object:

**Included (independently valid):**
- `server`: existing `apiKey` (preserved — no evidence it was individually
  exposed, only the ngrok token was), `tailscaleHost`, `tailscaleServePort`,
  `tailscaleFunnelPort`, `cursorBaseUrl`, `exposedModel`.
- `providers`: `claude`, `codex`, `cursor` (all `type: "builtin"`, same
  command/model/models/timeoutMs as live), `lmstudio` (`type: "http"`,
  clean main's generic OpenAI-compatible provider path — same baseUrl/
  apiKey/model as live).
- `routing`: `defaultProvider: "codex"`; `fallbackChain` filtered to
  `["codex","claude","cursor","lmstudio"]` (antigravity dropped);
  `taskRoutes` limited to the seven keys clean main's schema defines,
  remapped off antigravity onto `codex`/`cursor` per clean main's own
  defaults for those slots.
- `orchestration`: `{enabled: true, mode: "shadow"}` — rest filled from
  `DEFAULT_ORCHESTRATION_CONFIG` via `mergeOrchestrationConfig`.

**Explicitly excluded:** `providers.antigravity`, `routing.smartRoute`
(the entire canary/guard/escalation/optimization/modelRefresh subtree),
`routing.namedRoutes`, `routing.taskPatterns` (not part of clean main's
schema), `server.tunnels` (old ngrok token + cloudflared settings).

Result written to `/home/sketch/Projects/paragon-production/data/config.json`
(gitignored — never committed). `server.port` currently `4117` (final
value; the runbook temporarily borrows 4118 for a systemd-level dry run,
then restores 4117 before the real cutover).

## Stage 3 validation (ad hoc `node src/server.js`, port 4118, isolated data dir)

All against real infrastructure (the preserved API key, real CLI auth),
minimal request count by design:

| Check | Result |
|---|---|
| `/health` | 200 `{"ok":true}` |
| `/v1/models` | 200, `["paragon","routerbot-local"]` |
| Dashboard root | 200 |
| `/api/orchestration/status` (idle) | `enforcementMode: "shadow"`, all active counts 0 |
| Non-streaming completion | 200, real response ("pong"), correct `X-Paragon-*` headers |
| Streaming completion | 200, served by `claude`, correct headers, valid SSE |
| Implicit session/job closure | active counts returned to 0 after both requests |
| Per-attempt record | 1 attempt, `provider: claude`, real `processId`, correct duration |
| JSONL persistence | `attempts/jobs/runs/sessions.jsonl` all present and populated |
| SmartRoute API surface | `GET /api/smart-route/status` → 404 (absent, as required) |
| Restart recovery | killed cleanly, restarted, healthy in 140ms, both prior runs recovered from JSONL |
| Port 4117 interference | PID 255153 unchanged throughout; confirmed before and after |

Instance was stopped after validation — nothing left running.

## Runbook revision (v2)

The operator reviewed the v1 runbook before running it and caught two real
defects, both confirmed against the actual repo scripts:

1. v1 called `scripts/install-systemd.sh` directly for the 4118 dry run.
   That script unconditionally enables+starts `paragon-tailscale.service`,
   whose `ExecStart` is `scripts/tailscale-setup.sh` — which defaults
   `LOCAL_PORT` to `4117` (nothing sets `PARAGON_PORT`), independent of
   the `4118` value in `data/config.json`. That would re-touch the live
   Tailscale serve/funnel mapping during what was supposed to be an
   isolated systemd-wiring dry run.
2. v1's final command (`tailscale funnel 4117 on`) is not valid syntax for
   the installed CLI (v1.98.9, confirmed via `tailscale funnel --help`)
   and would not correctly restore the public listener on `:10000`.

v2 (now in place at `STAGE4_CUTOVER_RUNBOOK.sh`) installs only
`paragon.service` by hand (same `sed` substitution `install-systemd.sh`
does, minus the tailscale unit) so Tailscale state is untouched until the
real cutover step, and uses `--bg --https=<port> <target>` syntax matching
`scripts/tailscale-setup.sh`'s own working invocation. One further fix
made while reviewing v2: the "turn mapping off" lines had a stray extra
positional argument (`tailscale funnel --https=10000 4117 off`) that
`serve`/`funnel` don't accept — corrected to `--https=10000 off`.

Trade-off accepted: v2 does not install `paragon-tailscale.service`, so a
future reboot brings `paragon.service` back up but does not re-run
Tailscale serve/funnel setup automatically. Flagged as a follow-up, not a
cutover blocker — the running config survives reboot either way since
`tailscale serve`/`funnel` state itself persists independent of the
oneshot unit that originally set it.

## What remains (root required — not performed by this agent)

1. ~~Rotate the leaked ngrok token~~ — done, confirmed by operator
   2026-07-28.
2. Run `STAGE4_CUTOVER_RUNBOOK.sh` (v2) — installs `paragon.service`
   directly (not via `install-systemd.sh`, see above), validates it on a
   borrowed port 4118 first, then performs the actual swap: stop+disable
   `routerbot.service`, point the clean service at `:4117`, restore
   Tailscale serve+Funnel, validate publicly.
3. Post-cutover validation and canary per the directive's Stage 5.

## Verdict

**Not `PARAGON_D002C_CLEAN_PRODUCTION_CUTOVER_QUALIFIED`** — the directive's
qualifying conditions require the live port 4117 to actually be running
`fcd73f0` under `paragon.service` with `routerbot.service` stopped and
disabled. That hasn't happened yet; it can't happen without interactive
root access this session doesn't have.

Everything that can be true without root is true: the clean checkout is
validated byte-for-byte against the directive's preconditions, the
migrated configuration is schema-correct and allowlist-clean, the
candidate build has been proven against real providers on an isolated
port, and port 4117 has not been touched at any point.

**`PARAGON_D002C_PARTIAL`** — ready for cutover, blocked only on (1) the
operator rotating the ngrok token and (2) the operator running the
provided runbook with their own sudo credentials.
