#!/usr/bin/env bash
# Show cloudflared + ngrok tunnel status and Cursor connection values.
set -euo pipefail

# shellcheck source=tunnel-common.sh
source "$(dirname "$0")/tunnel-common.sh"
tunnel_load_env

echo "RouterBot local: $ROUTERBOT_LOCAL_URL"
echo ""

"$(dirname "$0")/tunnel-cloudflared.sh" status
echo ""
"$(dirname "$0")/tunnel-ngrok.sh" status

if [[ -f "$TUNNEL_URLS_FILE" ]]; then
  echo ""
  echo "Saved tunnel URLs: $TUNNEL_URLS_FILE"
fi
