#!/usr/bin/env bash
# Install systemd units for cloudflared and ngrok tunnels (optional, for boot persistence).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARAGON_USER="${PARAGON_USER:-${ROUTERBOT_USER:-$(stat -c '%U' "$REPO_DIR")}}"
PARAGON_GROUP="${PARAGON_GROUP:-${ROUTERBOT_GROUP:-$(id -gn "$PARAGON_USER" 2>/dev/null || echo "$PARAGON_USER")}}"
PARAGON_PORT="${PARAGON_PORT:-${ROUTERBOT_PORT:-4117}}"
ENV_PATH="/etc/paragon/environment"
CF_UNIT="/etc/systemd/system/paragon-cloudflared.service"
NGROK_UNIT="/etc/systemd/system/paragon-ngrok.service"

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
    PARAGON_USER="$PARAGON_USER" \
    PARAGON_GROUP="$PARAGON_GROUP" \
    PARAGON_PORT="$PARAGON_PORT" \
    NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}" \
    "$0" "$@"
fi

mkdir -p /etc/paragon
if [[ ! -f "$ENV_PATH" ]]; then
  cat >"$ENV_PATH" <<EOF
# PARAGON environment — edit and restart services
PARAGON_PORT=${PARAGON_PORT}
# NGROK_AUTHTOKEN=   # https://dashboard.ngrok.com/get-started/your-authtoken
EOF
  chmod 644 "$ENV_PATH"
fi

sed \
  -e "s|%PARAGON_USER%|${PARAGON_USER}|g" \
  -e "s|%PARAGON_GROUP%|${PARAGON_GROUP}|g" \
  -e "s|%PARAGON_DIR%|${REPO_DIR}|g" \
  -e "s|%PARAGON_PORT%|${PARAGON_PORT}|g" \
  "${REPO_DIR}/deploy/paragon-cloudflared.service" >"$CF_UNIT"

if [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
  echo "WARN: NGROK_AUTHTOKEN not set — ngrok unit will fail until you add it to $ENV_PATH"
fi

sed \
  -e "s|%PARAGON_USER%|${PARAGON_USER}|g" \
  -e "s|%PARAGON_GROUP%|${PARAGON_GROUP}|g" \
  -e "s|%PARAGON_DIR%|${REPO_DIR}|g" \
  -e "s|%PARAGON_PORT%|${PARAGON_PORT}|g" \
  -e "s|%NGROK_BIN%|${NGROK_BIN}|g" \
  "${REPO_DIR}/deploy/paragon-ngrok.service" >"$NGROK_UNIT"

systemctl daemon-reload
systemctl enable paragon-cloudflared.service
systemctl restart paragon-cloudflared.service

if [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  systemctl enable paragon-ngrok.service
  systemctl restart paragon-ngrok.service
  echo "ngrok: enabled and started"
else
  systemctl disable paragon-ngrok.service 2>/dev/null || true
  echo "ngrok: skipped (set NGROK_AUTHTOKEN in $ENV_PATH then: sudo systemctl enable --now paragon-ngrok)"
fi

echo ""
echo "cloudflared unit: $CF_UNIT"
echo "ngrok unit:       $NGROK_UNIT"
echo ""
echo "Get public URLs from logs (cloudflared URL changes on each restart):"
echo "  sudo journalctl -u paragon-cloudflared -f | grep trycloudflare"
echo "  curl -s http://127.0.0.1:4040/api/tunnels   # ngrok local API"
echo ""
echo "Or use foreground scripts (writes data/tunnel-urls.json):"
echo "  ./scripts/tunnel-cloudflared.sh start"
echo "  ./scripts/tunnel-ngrok.sh start"
echo "  ./scripts/tunnel-status.sh"
