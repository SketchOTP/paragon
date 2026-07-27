#!/usr/bin/env bash
# Quick Cloudflare Tunnel (trycloudflare.com) → PARAGON. No account required.
set -euo pipefail

# shellcheck source=tunnel-common.sh
source "$(dirname "$0")/tunnel-common.sh"

CF_BIN="$(tunnel_cloudflared_bin)"
CF_LOG="${DATA_DIR}/cloudflared.log"
CF_PID="${DATA_DIR}/cloudflared.pid"
CF_WAIT_SECS="${CLOUDFLARED_WAIT_SECS:-45}"

cf_url_from_log() {
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1
}

cf_is_running() {
  [[ -f "$CF_PID" ]] && kill -0 "$(cat "$CF_PID")" 2>/dev/null
}

cf_stop() {
  if cf_is_running; then
    kill "$(cat "$CF_PID")" 2>/dev/null || true
    sleep 1
    kill -9 "$(cat "$CF_PID")" 2>/dev/null || true
  fi
  rm -f "$CF_PID"
}

cf_start_bg() {
  tunnel_ensure_data_dir
  if cf_is_running; then
    echo "cloudflared already running (pid $(cat "$CF_PID"))"
    cf_status
    return 0
  fi
  rm -f "$CF_LOG"
  nohup "$CF_BIN" tunnel --url "$PARAGON_LOCAL_URL" --no-autoupdate >"$CF_LOG" 2>&1 &
  echo $! >"$CF_PID"
  echo "Starting cloudflared (pid $(cat "$CF_PID"))..."

  local url=""
  for _ in $(seq 1 "$CF_WAIT_SECS"); do
    url="$(cf_url_from_log)"
    if [[ -n "$url" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$url" ]]; then
    echo "ERROR: No trycloudflare.com URL in log after ${CF_WAIT_SECS}s. See $CF_LOG" >&2
    tail -20 "$CF_LOG" >&2
    exit 1
  fi

  tunnel_merge_json_field cloudflared url "$url"
  tunnel_merge_json_field cloudflared cursorBaseUrl "${url}/v1"
  tunnel_merge_json_field cloudflared cursorAgentBaseUrl "${url}/v1/cursor"
  echo "OK: $url"
  tunnel_print_cursor_hint "${url}/v1" "cloudflared"
}

cf_status() {
  if cf_is_running; then
    echo "cloudflared: running (pid $(cat "$CF_PID"))"
  else
    echo "cloudflared: stopped"
  fi
  if [[ -f "$TUNNEL_URLS_FILE" ]]; then
    python3 - "$TUNNEL_URLS_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
c = data.get("cloudflared", {})
if c.get("url"):
    print(f"  URL:           {c['url']}")
    print(f"  Cursor /v1:    {c.get('cursorBaseUrl', c['url'] + '/v1')}")
    if c.get("updatedAt"):
        print(f"  updated:       {c['updatedAt']}")
PY
  fi
}

case "${1:-start}" in
  start) cf_start_bg ;;
  stop) cf_stop; echo "cloudflared stopped" ;;
  status) cf_status ;;
  foreground)
    exec "$CF_BIN" tunnel --url "$PARAGON_LOCAL_URL" --no-autoupdate
    ;;
  *)
    echo "Usage: $0 [start|stop|status|foreground]" >&2
    exit 1
    ;;
esac
