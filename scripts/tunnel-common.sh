# Shared helpers for cloudflared / ngrok tunnels. Source from tunnel-*.sh only.
set -euo pipefail

tunnel_repo_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

ROUTERBOT_DIR="${ROUTERBOT_DIR:-$(tunnel_repo_dir)}"
ROUTERBOT_PORT="${ROUTERBOT_PORT:-4117}"
ROUTERBOT_LOCAL_URL="http://127.0.0.1:${ROUTERBOT_PORT}"
TUNNEL_URLS_FILE="${ROUTERBOT_TUNNEL_URLS_FILE:-${ROUTERBOT_DIR}/data/tunnel-urls.json}"
DATA_DIR="${ROUTERBOT_DIR}/data"

tunnel_ensure_data_dir() {
  mkdir -p "$DATA_DIR"
}

tunnel_cloudflared_bin() {
  if [[ -n "${CLOUDFLARED_BIN:-}" && -x "${CLOUDFLARED_BIN}" ]]; then
    echo "$CLOUDFLARED_BIN"
    return
  fi
  if [[ -x "${ROUTERBOT_DIR}/bin/cloudflared" ]]; then
    echo "${ROUTERBOT_DIR}/bin/cloudflared"
    return
  fi
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return
  fi
  echo "ERROR: cloudflared not found. Run: ./scripts/install-cloudflared.sh" >&2
  exit 1
}

tunnel_ngrok_bin() {
  if [[ -n "${NGROK_BIN:-}" && -x "${NGROK_BIN}" ]]; then
    echo "$NGROK_BIN"
    return
  fi
  if command -v ngrok >/dev/null 2>&1; then
    command -v ngrok
    return
  fi
  if [[ -x /snap/bin/ngrok ]]; then
    echo /snap/bin/ngrok
    return
  fi
  echo "ERROR: ngrok not found. Install: snap install ngrok" >&2
  exit 1
}

tunnel_load_env() {
  if [[ -f /etc/routerbot/environment ]]; then
    # shellcheck disable=SC1091
    set -a
    source /etc/routerbot/environment
    set +a
  fi
  if [[ -f "${ROUTERBOT_DIR}/.env" ]]; then
    # shellcheck disable=SC1091
    set -a
    source "${ROUTERBOT_DIR}/.env"
    set +a
  fi
  if [[ -z "${NGROK_AUTHTOKEN:-}" && -f "${ROUTERBOT_DIR}/data/config.json" ]]; then
    NGROK_AUTHTOKEN="$(python3 -c "import json;print(json.load(open('${ROUTERBOT_DIR}/data/config.json')).get('server',{}).get('tunnels',{}).get('ngrokAuthtoken',''))")"
  fi
}

tunnel_merge_json_field() {
  local provider="$1"
  local field="$2"
  local value="$3"
  tunnel_ensure_data_dir
  python3 - "$TUNNEL_URLS_FILE" "$provider" "$field" "$value" <<'PY'
import json, sys, datetime
from pathlib import Path

path = Path(sys.argv[1])
provider, field, value = sys.argv[2], sys.argv[3], sys.argv[4]
data = {}
if path.exists():
    data = json.loads(path.read_text())
entry = data.get(provider, {})
entry[field] = value
entry["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
data[provider] = entry
path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

tunnel_print_cursor_hint() {
  local base_url="$1"
  local label="$2"
  echo ""
  echo "Cursor (${label}):"
  echo "  Override OpenAI Base URL: ${base_url}"
  echo "  API key:                  (from dashboard or data/config.json)"
  echo "  Model:                    routerbot-local"
}
