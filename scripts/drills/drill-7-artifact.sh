#!/usr/bin/env bash
# Exit drill 7 — the artifact test: the entire Phase 1 system boots on a clean
# machine from the compose profile. Delegates to the ticket-011 smoke script.
set -euo pipefail
if ! docker info >/dev/null 2>&1; then
  echo "FAIL: drill 7 (artifact) — Docker is not available in this environment; run in CI."
  exit 1
fi
"$(dirname "${BASH_SOURCE[0]}")/../artifact-smoke.sh"
echo "PASS: drill 7 (artifact test)"
