#!/usr/bin/env bash
# Install systemd units for cloudflared and ngrok tunnels (optional, for boot persistence).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROUTERBOT_USER="${ROUTERBOT_USER:-$(stat -c '%U' "$REPO_DIR")}"
ROUTERBOT_GROUP="${ROUTERBOT_GROUP:-$(id -gn "$ROUTERBOT_USER" 2>/dev/null || echo "$ROUTERBOT_USER")}"
ROUTERBOT_PORT="${ROUTERBOT_PORT:-4117}"
ENV_PATH="/etc/routerbot/environment"
CF_UNIT="/etc/systemd/system/routerbot-cloudflared.service"
NGROK_UNIT="/etc/systemd/system/routerbot-ngrok.service"

# shellcheck source=tunnel-common.sh
source "$REPO_DIR/scripts/tunnel-common.sh"
tunnel_load_env

if [[ ! -x "${REPO_DIR}/bin/cloudflared" ]]; then
  "$REPO_DIR/scripts/install-cloudflared.sh"
fi

NGROK_BIN="$(tunnel_ngrok_bin)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Re-running with sudo..."
  exec sudo env \
    ROUTERBOT_USER="$ROUTERBOT_USER" \
    ROUTERBOT_GROUP="$ROUTERBOT_GROUP" \
    ROUTERBOT_PORT="$ROUTERBOT_PORT" \
    NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}" \
    "$0" "$@"
fi

mkdir -p /etc/routerbot
if [[ ! -f "$ENV_PATH" ]]; then
  cat >"$ENV_PATH" <<EOF
# RouterBot environment — edit and restart services
ROUTERBOT_PORT=${ROUTERBOT_PORT}
# NGROK_AUTHTOKEN=   # https://dashboard.ngrok.com/get-started/your-authtoken
EOF
  chmod 644 "$ENV_PATH"
fi

sed \
  -e "s|%ROUTERBOT_USER%|${ROUTERBOT_USER}|g" \
  -e "s|%ROUTERBOT_GROUP%|${ROUTERBOT_GROUP}|g" \
  -e "s|%ROUTERBOT_DIR%|${REPO_DIR}|g" \
  -e "s|%ROUTERBOT_PORT%|${ROUTERBOT_PORT}|g" \
  "${REPO_DIR}/deploy/routerbot-cloudflared.service" >"$CF_UNIT"

if [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
  echo "WARN: NGROK_AUTHTOKEN not set — ngrok unit will fail until you add it to $ENV_PATH"
fi

sed \
  -e "s|%ROUTERBOT_USER%|${ROUTERBOT_USER}|g" \
  -e "s|%ROUTERBOT_GROUP%|${ROUTERBOT_GROUP}|g" \
  -e "s|%ROUTERBOT_DIR%|${REPO_DIR}|g" \
  -e "s|%ROUTERBOT_PORT%|${ROUTERBOT_PORT}|g" \
  -e "s|%NGROK_BIN%|${NGROK_BIN}|g" \
  "${REPO_DIR}/deploy/routerbot-ngrok.service" >"$NGROK_UNIT"

systemctl daemon-reload
systemctl enable routerbot-cloudflared.service
systemctl restart routerbot-cloudflared.service

if [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  systemctl enable routerbot-ngrok.service
  systemctl restart routerbot-ngrok.service
  echo "ngrok: enabled and started"
else
  systemctl disable routerbot-ngrok.service 2>/dev/null || true
  echo "ngrok: skipped (set NGROK_AUTHTOKEN in $ENV_PATH then: sudo systemctl enable --now routerbot-ngrok)"
fi

echo ""
echo "cloudflared unit: $CF_UNIT"
echo "ngrok unit:       $NGROK_UNIT"
echo ""
echo "Get public URLs from logs (cloudflared URL changes on each restart):"
echo "  sudo journalctl -u routerbot-cloudflared -f | grep trycloudflare"
echo "  curl -s http://127.0.0.1:4040/api/tunnels   # ngrok local API"
echo ""
echo "Or use foreground scripts (writes data/tunnel-urls.json):"
echo "  ./scripts/tunnel-cloudflared.sh start"
echo "  ./scripts/tunnel-ngrok.sh start"
echo "  ./scripts/tunnel-status.sh"
