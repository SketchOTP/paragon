#!/usr/bin/env bash
set -euo pipefail

# Installs the matched OpenHands SDK/tool pair outside the repository so the
# service can run it without polluting PARAGON's Node dependencies.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${OPENHANDS_VENV_DIR:-${ROOT_DIR}/.openhands-venv}"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required; install it from https://docs.astral.sh/uv/" >&2
  exit 1
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "bwrap is required for workspace-only OpenHands execution." >&2
  exit 1
fi

uv venv "${VENV_DIR}"
uv pip install --python "${VENV_DIR}/bin/python" \
  "openhands-sdk==1.39.1" \
  "openhands-tools==1.39.1"

echo
echo "OpenHands installed. Run it through PARAGON with:"
echo "  ${VENV_DIR}/bin/python scripts/openhands_runner.py"
echo "Set PARAGON_API_KEY and pass an explicit workspace in the JSON request."
