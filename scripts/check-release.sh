#!/usr/bin/env bash
# Pre-publish checks (also run in CI).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Scanning for personal hostnames and paths..."
if grep -rE 'atlas-2|tail1a5964|/home/sketch' \
  --include='*.js' --include='*.md' --include='*.sh' --include='*.html' \
  --exclude='check-release.sh' \
  --exclude='repo_map.md' --exclude='notes.md' --exclude='setup_repo.md' \
  --exclude='AGENTS.md' --exclude='CLAUDE.md' --exclude='.cursorrules' \
  --exclude='project_*.md' \
  --exclude-dir=node_modules --exclude-dir=data --exclude-dir=test --exclude-dir=.git \
  --exclude-dir=project_memory .; then
  echo "FAIL: Found sensitive patterns in tracked source files." >&2
  exit 1
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files --error-unmatch data/config.json >/dev/null 2>&1; then
    echo "FAIL: data/config.json must not be committed (contains local secrets)." >&2
    exit 1
  fi
fi

test -f public/paragon-logo.png || { echo "FAIL: missing public/paragon-logo.png" >&2; exit 1; }
test -f public/paragon-banner.png || { echo "FAIL: missing public/paragon-banner.png" >&2; exit 1; }
test -f LICENSE || { echo "FAIL: missing LICENSE" >&2; exit 1; }

echo "OK: release checks passed"
