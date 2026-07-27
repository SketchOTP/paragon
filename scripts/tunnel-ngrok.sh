#!/usr/bin/env bash
# ngrok tunnel → PARAGON. Requires NGROK_AUTHTOKEN (free account).
set -euo pipefail

# shellcheck source=tunnel-common.sh
source "$(dirname "$0")/tunnel-common.sh"
tunnel_load_env

NGROK_LOG="${DATA_DIR}/ngrok.log"
NGROK_PID="${DATA_DIR}/ngrok.pid"
NGROK_API="http://127.0.0.1:4040/api/tunnels"
NGROK_WAIT_SECS="${NGROK_WAIT_SECS:-30}"
NGROK_BIN=""

ngrok_is_running() {
  [[ -f "$NGROK_PID" ]] && kill -0 "$(cat "$NGROK_PID")" 2>/dev/null
}

ngrok_stop() {
  if ngrok_is_running; then
    kill "$(cat "$NGROK_PID")" 2>/dev/null || true
    sleep 1
    kill -9 "$(cat "$NGROK_PID")" 2>/dev/null || true
  fi
  rm -f "$NGROK_PID"
}

ngrok_require_token() {
  if [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
    cat >&2 <<'EOF'
ERROR: NGROK_AUTHTOKEN is not set.

1. Sign up: https://dashboard.ngrok.com/signup
2. Copy token: https://dashboard.ngrok.com/get-started/your-authtoken
3. Add to PARAGON .env or /etc/paragon/environment:
     NGROK_AUTHTOKEN=your_token_here
4. Re-run: ./scripts/tunnel-ngrok.sh start
EOF
    exit 1
  fi
}

ngrok_public_url() {
  curl -sf "$NGROK_API" 2>/dev/null | python3 - <<'PY'
import json, sys
try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(1)
for t in data.get("tunnels", []):
    url = t.get("public_url", "")
    if url.startswith("https://"):
        print(url)
        break
PY
}

ngrok_start_bg() {
  NGROK_BIN="$(tunnel_ngrok_bin)"
  ngrok_require_token
  tunnel_ensure_data_dir
  if ngrok_is_running; then
    echo "ngrok already running (pid $(cat "$NGROK_PID"))"
    ngrok_status
    return 0
  fi

  rm -f "$NGROK_LOG"
  nohup env NGROK_AUTHTOKEN="$NGROK_AUTHTOKEN" \
    "$NGROK_BIN" http "$PARAGON_PORT" --log=stdout >"$NGROK_LOG" 2>&1 &
  echo $! >"$NGROK_PID"
  echo "Starting ngrok (pid $(cat "$NGROK_PID"))..."

  local url=""
  for _ in $(seq 1 "$NGROK_WAIT_SECS"); do
    url="$(ngrok_public_url)"
    if [[ -n "$url" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$url" ]]; then
    echo "ERROR: ngrok did not publish a public URL. See $NGROK_LOG" >&2
    tail -30 "$NGROK_LOG" >&2
    ngrok_stop
    exit 1
  fi

  tunnel_merge_json_field ngrok url "$url"
  tunnel_merge_json_field ngrok cursorBaseUrl "${url}/v1"
  tunnel_merge_json_field ngrok cursorAgentBaseUrl "${url}/v1/cursor"
  echo "OK: $url"
  tunnel_print_cursor_hint "${url}/v1" "ngrok"
}

ngrok_status() {
  if ngrok_is_running; then
    echo "ngrok: running (pid $(cat "$NGROK_PID"))"
    local live
    live="$(ngrok_public_url)"
    if [[ -n "$live" ]]; then
      echo "  live URL:      $live"
      echo "  Cursor /v1:    ${live}/v1"
    fi
  else
    echo "ngrok: stopped"
  fi
  if [[ -f "$TUNNEL_URLS_FILE" ]]; then
    python3 - "$TUNNEL_URLS_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
n = data.get("ngrok", {})
if n.get("url"):
    print(f"  saved URL:     {n['url']}")
    print(f"  saved /v1:     {n.get('cursorBaseUrl', n['url'] + '/v1')}")
    if n.get("updatedAt"):
        print(f"  updated:       {n['updatedAt']}")
PY
  fi
}

case "${1:-start}" in
  start) ngrok_start_bg ;;
  stop) ngrok_stop; echo "ngrok stopped" ;;
  status) ngrok_status ;;
  foreground)
    NGROK_BIN="$(tunnel_ngrok_bin)"
    ngrok_require_token
    exec env NGROK_AUTHTOKEN="$NGROK_AUTHTOKEN" \
      "$NGROK_BIN" http "$PARAGON_PORT"
    ;;
  *)
    echo "Usage: $0 [start|stop|status|foreground]" >&2
    exit 1
    ;;
esac
