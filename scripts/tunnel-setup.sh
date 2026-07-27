#!/usr/bin/env bash
# Start both public tunnels for Cursor (cloudflared + ngrok).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tunnel-common.sh
source "$DIR/tunnel-common.sh"
tunnel_load_env

if [[ ! -x "$(tunnel_cloudflared_bin 2>/dev/null || true)" ]]; then
  "$DIR/install-cloudflared.sh"
fi

echo "=== Cloudflare Tunnel (no account) ==="
"$DIR/tunnel-cloudflared.sh" start

echo ""
echo "=== ngrok (requires NGROK_AUTHTOKEN) ==="
if [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  "$DIR/tunnel-ngrok.sh" start
else
  echo "SKIP: set NGROK_AUTHTOKEN in .env or /etc/paragon/environment (or legacy /etc/routerbot/environment), then run:"
  echo "  ./scripts/tunnel-ngrok.sh start"
fi

echo ""
"$DIR/tunnel-status.sh"
