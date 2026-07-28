#!/usr/bin/env bash
# Smoke-check RouterBot local health and optional Tailscale URLs.
set -euo pipefail

LOCAL_PORT="${ROUTERBOT_PORT:-4117}"
HOST="${ROUTERBOT_TAILSCALE_HOST:-}"
SERVE_PORT="${ROUTERBOT_TAILSCALE_SERVE_PORT:-9420}"
FUNNEL_PORT="${ROUTERBOT_TAILSCALE_FUNNEL_PORT:-10000}"

ok() { echo "OK: $*"; }
bad() { echo "FAIL: $*"; exit 1; }

if curl -sf "http://127.0.0.1:${LOCAL_PORT}/health" >/dev/null; then
  ok "local health http://127.0.0.1:${LOCAL_PORT}/health"
else
  bad "local health check failed — is RouterBot running?"
fi

if systemctl is-active --quiet routerbot 2>/dev/null; then
  ok "systemd: routerbot is active"
else
  echo "WARN: systemd routerbot is not active (optional if running manually)"
fi

if [[ -n "${HOST}" ]]; then
  if curl -sfk "https://${HOST}:${SERVE_PORT}/health" >/dev/null 2>&1; then
    ok "tailnet https://${HOST}:${SERVE_PORT}/health"
  else
    echo "WARN: tailnet serve check failed — run ./scripts/tailscale-setup.sh"
  fi
  if curl -sfk "https://${HOST}:${FUNNEL_PORT}/health" >/dev/null 2>&1; then
    ok "funnel https://${HOST}:${FUNNEL_PORT}/health"
  else
    echo "WARN: funnel check failed — run ./scripts/tailscale-setup.sh"
  fi
else
  echo "INFO: set ROUTERBOT_TAILSCALE_HOST to check Tailscale URLs"
fi
