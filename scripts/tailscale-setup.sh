#!/usr/bin/env bash
# Expose PARAGON on Tailscale HTTPS ports (tailnet serve + public funnel).
set -euo pipefail

LOCAL_PORT="${PARAGON_PORT:-${ROUTERBOT_PORT:-4117}}"
SERVE_PORT="${PARAGON_TAILSCALE_SERVE_PORT:-${ROUTERBOT_TAILSCALE_SERVE_PORT:-9420}}"
FUNNEL_PORT="${PARAGON_TAILSCALE_FUNNEL_PORT:-${ROUTERBOT_TAILSCALE_FUNNEL_PORT:-10000}}"

echo "PARAGON local port: ${LOCAL_PORT}"
echo "Tailnet HTTPS port:    ${SERVE_PORT} (dashboard + API on tailnet)"
echo "Funnel HTTPS port:     ${FUNNEL_PORT} (public — use in Cursor Agent)"

sudo tailscale funnel --https=443 off 2>/dev/null || true

echo "Configuring tailnet serve on :${SERVE_PORT}..."
sudo tailscale serve --bg --https="${SERVE_PORT}" "${LOCAL_PORT}"

echo "Configuring public funnel on :${FUNNEL_PORT}..."
sudo tailscale funnel --bg --https="${FUNNEL_PORT}" "${LOCAL_PORT}"

echo ""
tailscale serve status
echo ""
tailscale funnel status

HOST="$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || true)"
if [[ -z "${HOST}" ]]; then
  echo ""
  echo "Could not detect Tailscale hostname. Set server.tailscaleHost in data/config.json manually."
  exit 0
fi

echo ""
echo "Tailnet dashboard:  https://${HOST}:${SERVE_PORT}/"
echo "Cursor base URL:    https://${HOST}:${FUNNEL_PORT}/v1"
echo "Update data/config.json → server.tailscaleHost and server.cursorBaseUrl if needed."
