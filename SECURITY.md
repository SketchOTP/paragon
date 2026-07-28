# Security

PARAGON exposes an OpenAI-compatible API and a web dashboard on the same HTTP server. Treat it like any service that can run code and read secrets on the host.

## API key

- PARAGON generates a random API key on first startup and saves it to `data/config.json` (see README → **API key**).
- The same key protects **both** `/v1/*` (OpenAI-compatible API) and `/api/*` (dashboard).
- Set `PARAGON_API_KEY` in the environment to override the config file (deprecated `ROUTERBOT_API_KEY` still works for one migration release).
- **Never** commit `data/config.json` or share your API key publicly.

When accessing the dashboard over Tailscale or a tunnel, enter the API key in the prompt (stored in browser session storage for that tab).

Localhost dashboard access (`127.0.0.1`) is allowed without a key for convenience; remote access always requires the key.

## Public exposure (Tailscale Funnel, ngrok, cloudflared)

If you expose PARAGON to the internet:

1. Use a strong, unique API key.
2. Understand that anyone with the key can call `/v1` **and** change config via `/api/config`.
3. Restrict Tailscale Funnel with [Tailscale ACLs](https://tailscale.com/kb/1018/acls) where possible.
4. Prefer tailnet-only access (`tailscale serve`) for the dashboard and a separate Funnel port only for remote API clients.

## Provider credentials

PARAGON does not store provider API keys in the repository. Credentials live in:

- `data/config.json` (HTTP provider keys you configure)
- CLI OAuth/token files in the service user's home directory (`~/.codex`, `~/.cursor`, `~/.gemini`, etc.)

Run PARAGON under a dedicated user account with minimal filesystem permissions.

## CLI safety

Built-in CLI adapters use read-only or ask-only modes where supported. Custom CLI providers run whatever command you configure — review commands before enabling them.

## Reporting issues

Report security issues privately to the repository maintainer rather than opening a public issue with exploit details.
