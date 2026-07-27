<p align="center">
  <img src="public/paragon.png" alt="PARAGON" width="120" />
</p>

<h1 align="center">PARAGON</h1>

<p align="center">
  <strong>An adaptive, quota-aware AI coding orchestrator behind one OpenAI-compatible endpoint.</strong>
</p>

<p align="center">
  Claude Code · Codex · Cursor Agent · Antigravity CLI · Ollama · vLLM · custom CLIs
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-green.svg" alt="Node 20+" /></a>
</p>

---

PARAGON (formerly RouterBot) is a self-hosted **OpenAI-compatible API router**, now being extended into an
**adaptive orchestration layer** on top of that router. Point any client that supports a custom OpenAI base
URL, model name, and API key at PARAGON — IDEs, chat UIs, agents, scripts, or your own app. Today PARAGON
classifies each request by keyword, picks a backend provider, runs your configured CLIs or HTTP APIs, and
falls back automatically when something fails — that's the same routing behavior RouterBot always had, and
it keeps serving every request unchanged. Running alongside it, in shadow mode by default, is an adaptive
routing engine that scores every request against a live model registry (capability, cost, historical
success, provider health) and logs what it *would* have chosen, without ever serving a request itself yet.
See [Orchestration (adaptive routing)](#orchestration-adaptive-routing) below.

**Works with:** Continue, Open WebUI, LibreChat, LangChain, custom HTTP clients, and any tool that speaks `POST /v1/chat/completions`, `POST /v1/responses`, and `GET /v1/models`. Cursor (Ask and Agent with responses-compat) is a common example, not a requirement.

No vendor lock-in to one CLI — mix Anthropic, OpenAI, Google, and local models behind one dashboard and one API key.

## Renamed from RouterBot

This project shipped as **RouterBot** through v0.2.2 and is now **PARAGON** starting v0.3.0. Nothing about
how you use it changes on upgrade:

- `ROUTERBOT_*` environment variables keep working (with a deprecation warning) for one migration release —
  set the `PARAGON_*` equivalent when you get a chance.
- Existing `data/config.json` migrates automatically on first read; the old `routerbot-local` exposed model
  id is rewritten to `paragon` and still accepted by `/v1/models`.
- systemd unit/service names moved from `routerbot*` to `paragon*` — re-run `./scripts/install-systemd.sh`
  to install the renamed units (the old ones keep running until you do).

## What's new in v0.3.0

- **Renamed to PARAGON** — see [Renamed from RouterBot](#renamed-from-routerbot) for the migration path
- **Adaptive routing engine wired in (shadow mode)** — every request is scored by the smartRoute engine
  (model ranking, cost/budget policy, canary rollout, escalation) and logged for comparison, without
  affecting what actually serves the request
- **Orchestration dashboard** — routing policy, model rankings, decision log / shadow analysis, and
  session/subagent governor settings, all editable from the dashboard
- **Session & subagent governor config** — context/duration thresholds and subagent concurrency limits,
  config-driven and dashboard-visible ahead of a future PARAGON job/session layer
- **242+ automated tests** — including the previously-unwired smartRoute engine's test suite, now run by
  default

## Why PARAGON?

| Problem | PARAGON |
|---------|-----------|
| Each app wants its own base URL and backend | One `/v1` endpoint, many providers |
| Switching between Claude / Codex / Gemini is manual | Task-based routing (`code` → Codex, `plan` → Claude, …) |
| Remote server has no browser for CLI login | Dashboard opens OAuth/device-login URLs **on your PC** |
| Homelab needs HTTPS for remote clients | Built-in Tailscale Serve/Funnel helpers and URL preview |
| Want Ollama or vLLM beside cloud CLIs | HTTP providers + generic CLI adapters |

## Features

- **OpenAI-compatible API** — `/v1/models`, `/v1/chat/completions`, `/v1/responses` (streaming supported; Cursor Agent responses-compat)
- **Web dashboard** — enable providers, pick models, authenticate CLIs, live activity log
- **Task routing** — keyword classifier sends `code`, `debug`, `plan`, etc. to different backends
- **Fallback chain** — configurable order when the primary provider errors out
- **Built-in providers** — Claude Code, Codex, Cursor Agent, Antigravity CLI (`agy`)
- **Bring your own** — OpenAI-compatible HTTP (Ollama, LM Studio, vLLM) or any stdin CLI
- **Emoji provider icons** — click to customize; set when adding a provider
- **Security** — one API key for `/v1` and admin `/api`; auto-generated on first run
- **Production helpers** — systemd units, Tailscale setup script, health checks

## Quick start

**Requirements:** Node.js 20+, and whichever CLIs you enable on your `PATH`.

```bash
git clone git@github.com:SketchOTP/paragon.git
cd paragon
npm install
npm start
```

Open the dashboard: **http://127.0.0.1:4117**

On first run, PARAGON prints a generated API key — save it for API clients and remote dashboard access.

Optional: seed config from the example:

```bash
mkdir -p data
cp config.example.json data/config.json
# edit tailscaleHost, providers, routing…
```

## Connect a client

Any OpenAI-compatible client needs three values from the dashboard:

| Setting | Value |
|---------|-------|
| **Base URL** | PARAGON URL ending in `/v1` (e.g. `http://127.0.0.1:4117/v1`) |
| **API key** | Your PARAGON API key |
| **Model** | `paragon` (or your `server.exposedModel`) |

**Local only:** `http://127.0.0.1:4117/v1`

**Remote clients** (cloud agents, phones, other machines) need a reachable HTTPS URL — see [Public access](#public-access).

### Example: Cursor

Cursor routes BYOK requests through **its cloud**, not your PC. It blocks `localhost`, private IPs, and Tailscale (`100.x`) URLs. Use a **public HTTPS tunnel** — not `http://127.0.0.1:4117/v1` and not Tailscale MagicDNS.

| Setting | Value |
|---------|-------|
| Override OpenAI Base URL | `https://YOUR-TUNNEL-HOST/v1` (Ask/Plan) or `/v1/cursor` (if Agent BYOK sends traffic) |
| API key | PARAGON API key |
| Model | `paragon` |

**Which Cursor modes hit PARAGON?** Override OpenAI Base URL only applies to BYOK chat traffic Cursor sends to your URL. Today that is mainly **Ask** and **Plan**. **Agent**, **Multitask**, and **Debug Mode** (runtime log instrumentation — Shift+Tab → Debug) run on Cursor’s own agent backend and usually produce **no requests** to PARAGON, so dashboard routes for `agent`, `debug`, and `multitask` do nothing in those UI modes. The `debug` routing row applies when a BYOK request arrives with debug metadata/keywords (e.g. Ask + stack trace), not when you pick Debug Mode in the agent picker.

| Cursor UI | Hits PARAGON BYOK? |
|-----------|---------------------|
| Ask | Yes |
| Plan | Yes |
| Agent (Composer) | Usually no — Cursor backend |
| Debug Mode | No — separate agent loop |
| Multitask | Usually no — Cursor backend |

**Workaround for debug-style questions:** use **Ask** mode, paste the error/stack trace; PARAGON classifies as task `debug` and uses your `debug → provider` map.

**Quick setup (both tunnels):**

```bash
chmod +x scripts/*.sh
./scripts/tunnel-setup.sh          # cloudflared (no account) + ngrok if NGROK_AUTHTOKEN set
./scripts/tunnel-status.sh         # show URLs for Cursor
```

| Tunnel | Account | Script |
|--------|---------|--------|
| Cloudflare (`trycloudflare.com`) | None | `./scripts/tunnel-cloudflared.sh start` |
| ngrok | Free at [dashboard.ngrok.com](https://dashboard.ngrok.com/signup) | Set `NGROK_AUTHTOKEN` in `.env`, then `./scripts/tunnel-ngrok.sh start` |

URLs are saved to `data/tunnel-urls.json`. For boot persistence: `./scripts/install-tunnel-services.sh` (installs systemd units; cloudflared URL changes on each restart — check logs or re-run `tunnel-status.sh`).

**Cursor Agent mode:** When Cursor does send BYOK Agent traffic, it often uses OpenAI **Responses API** payloads (`input`, `instructions`, tools, …) — sometimes to `/v1/chat/completions` instead of standard `messages`. PARAGON accepts that on `/v1/chat/completions`, `/v1/responses`, and the same paths under `/v1/cursor`. Use **HTTP/1.1** in Cursor Settings → Network if streaming fails on Windows.

When BYOK requests reach PARAGON, mode is inferred from headers/metadata/payload and mapped via the dashboard (`ask`, `plan`, `agent`, `debug`, `multitask`). The Cursor provider passes matching `cursor-agent` CLI flags (`ask`/`plan` read-only, `agent`/`multitask` with `--force`).

### Example: curl

```bash
curl -s http://127.0.0.1:4117/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"paragon","messages":[{"role":"user","content":"Hello"}]}'
```

## Dashboard tour

Sign-in is unified across providers:

| Provider | Flow |
|----------|------|
| Claude / Cursor Agent | Browser link (opens on your PC) |
| Codex | Device URL + one-time code |
| Gemini | Google link + paste authorization code |

- If already signed in, the dashboard shows **Already signed in** (no blank popup).
- Click **Re-sign in** to force a fresh login.
- Click **↻** on a provider card to load its real model list.
- Health dots refresh automatically after sign-in completes.

```
┌─────────────────────────────────────────────────────────┐
│  Metrics: Base URL · Model · API key · Provider health  │
├─────────────────────────────────────────────────────────┤
│  Providers (cards)     │  Routing · Fallback chain     │
│  · toggle / model      │  · task → provider map        │
│  · sign-in buttons     │  · default provider           │
│  · emoji icons         │                               │
├────────────────────────┴───────────────────────────────┤
│  Activity log (API requests, routes, fallbacks, auth)   │
└─────────────────────────────────────────────────────────┘
```

- **Server settings** (gear) — Tailscale host, funnel ports, API key, exposed model name
- **Add provider** — HTTP API or generic CLI, with icon picker
- **Fallback chain** — reorder providers tried after a failure

## API key

One key protects both the OpenAI API (`/v1`) and the admin API (`/api`).

| How | Steps |
|-----|--------|
| **First startup** | Printed in the terminal when `data/config.json` has no key |
| **Dashboard** | `http://127.0.0.1:4117` → Server settings → API key |
| **Config file** | `grep apiKey data/config.json` |
| **Environment** | `PARAGON_API_KEY=…` (overrides file) |

Rotate anytime in Server settings → **Save** → update your clients.

If port `4117` is in use, PARAGON is already running (e.g. systemd) — use `sudo systemctl restart paragon` instead of a second `npm start`.

## Providers

### Built-in CLI backends

| Provider | CLI | Auth |
|----------|-----|------|
| Claude Code | `claude` | Browser sign-in (opens on your PC) |
| Codex | `codex` | Device login + one-time code |
| Cursor Agent | `cursor-agent` | Browser sign-in |
| Antigravity CLI | `agy` | Google OAuth + paste auth code ([install](https://antigravity.google/cli/install.sh)) |

Install Antigravity CLI:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

### Custom backends

**HTTP** (Ollama, vLLM, LM Studio, any OpenAI-compatible server):

```json
"ollama": {
  "type": "http",
  "label": "Ollama",
  "icon": "🦙",
  "enabled": true,
  "baseUrl": "http://127.0.0.1:11434/v1",
  "model": "llama3.2"
}
```

**Generic CLI** (any tool that reads a prompt on stdin):

```json
"my-cli": {
  "type": "generic-cli",
  "label": "My Tool",
  "icon": "🔧",
  "command": "my-cli",
  "runArgs": ["-m", "{{model}}", "-"],
  "model": "default"
}
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to extend built-in adapters.

## Routing & fallback

1. PARAGON classifies the prompt (`code`, `debug`, `plan`, …).
2. It uses the mapped provider from the dashboard (or `routing.defaultProvider`).
3. On failure, it walks `routing.fallbackChain` (default: `codex` → `cursor`).

Configure both in the **Routing** panel; new providers appear in dropdowns automatically.

**GHOST harness (observe-only analysis):** send `metadata.paragon_task: "ghost"` (or header
`X-PARAGON-Task: ghost`) to skip LLM task classification and use the `ghost → provider` route.
Default pattern also matches prompts starting with `Analyze GHOST live session`.

## Orchestration (adaptive routing)

Every request that goes through the routing above is also scored — in the background, without affecting
what actually serves the request — by an adaptive routing engine (`src/smartRoute/`). It's a model
ranker + cost/budget policy + canary rollout + escalation + decision log, evaluated against a live
provider/model registry.

**This ships shadow-only.** The engine computes what it would have picked, logs it alongside the legacy
decision that actually ran, and stops there. Nothing routes through it in this release. That's a deliberate,
reversible rollout stage (see `routing.smartRoute.mode` below) — not a limitation you need to work around.

Manage it from the **Orchestration** section of the dashboard:

- **Routing policy** — mode (`legacy` disables the engine entirely / `shadow_test` observes only, default /
  `balanced_live` canary-gated live serving / `manual`), classifier provider, confidence threshold, canary
  enable + percentage
- **Session governor** — context-size and session-duration thresholds a future PARAGON job/session layer
  (or any client that adopts these conventions) checkpoints and rolls over against
- **Subagent governor** — default/max subagent concurrency and whether recursive spawning is allowed;
  defaults to zero subagents, nothing enabled
- **Model rankings** — per-task-type ranked candidates from the current model registry snapshot, with score
  and tier
- **Shadow analysis** — match/diff rate between the legacy pick and the adaptive engine's pick, estimated
  cost delta, and the most recent logged decisions

Populate the model registry snapshot before rankings show data:

```bash
node src/smartRouteModelRefresh.js     # pricing/benchmark/health snapshot
node src/smartRouteReport.js           # full shadow-mode report from the decision log
```

`GET /api/orchestration/settings|rankings|decisions|shadow-report` back the dashboard panels and are usable
directly for scripting.

## Public access

Remote clients cannot reach `localhost`. Expose PARAGON over HTTPS when callers run on another machine or in the cloud.

### Tailscale (recommended)

```bash
./scripts/tailscale-setup.sh   # once, requires sudo
```

| Port | Use |
|------|-----|
| `9420` | Tailnet dashboard (private) |
| `10000` | Public Funnel → `https://YOUR_HOST:10000/v1` |

Set `server.tailscaleHost` in the dashboard, then **Save**.

### Quick tunnels (Cursor-compatible)

Use the bundled scripts (install cloudflared to `bin/` automatically):

```bash
./scripts/install-cloudflared.sh   # once, if needed
./scripts/tunnel-cloudflared.sh start
# NGROK_AUTHTOKEN=… in .env then:
./scripts/tunnel-ngrok.sh start
./scripts/tunnel-status.sh
```

Manual equivalents:

```bash
cloudflared tunnel --url http://127.0.0.1:4117
ngrok http 4117
```

Use the HTTPS URL + `/v1` as your client base URL.

## Run at boot (systemd)

```bash
chmod +x scripts/install-systemd.sh scripts/tailscale-setup.sh scripts/check-paragon.sh
./scripts/install-systemd.sh
```

```bash
PARAGON_USER=your-user ./scripts/install-systemd.sh
sudo systemctl status paragon
./scripts/check-paragon.sh
```

## Configuration

| Source | Purpose |
|--------|---------|
| `data/config.json` | Main config (created at runtime, **not** committed) |
| `config.example.json` | Starter template |
| `.env.example` | Environment variable reference |

| Variable | Description |
|----------|-------------|
| `PARAGON_HOST` | Bind address (default `127.0.0.1`) |
| `PARAGON_PORT` | Port (default `4117`) |
| `PARAGON_API_KEY` | API key override |

## Security

Read **[SECURITY.md](SECURITY.md)** before exposing PARAGON on the public internet.

- Use a strong, unique API key when using Tailscale Funnel or tunnels.
- Never commit `data/config.json` (contains keys and hostnames).
- Tailscale Funnel exposes the full app — protect with key + ACLs.

Built-in CLIs run in read-only / ask modes where supported; custom CLIs run whatever you configure.

## Development

```bash
npm run dev      # watch mode
npm test         # unit tests
npm run check    # tests + release scan
```

## License

MIT © [Tym Huseby](LICENSE)
