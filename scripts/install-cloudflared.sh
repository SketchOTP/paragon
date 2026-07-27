#!/usr/bin/env bash
# Download cloudflared into bin/ (no sudo). Used by tunnel-cloudflared.sh.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${REPO_DIR}/bin/cloudflared"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) CF_ARCH=amd64 ;;
  aarch64|arm64) CF_ARCH=arm64 ;;
  *)
    echo "Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

mkdir -p "${REPO_DIR}/bin"
URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
echo "Downloading cloudflared (${CF_ARCH})..."
curl -fsSL "$URL" -o "$BIN"
chmod +x "$BIN"
"$BIN" --version
echo "Installed: $BIN"
