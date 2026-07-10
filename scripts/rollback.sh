#!/usr/bin/env bash
# Rollback (ticket 028): ONE command, deliberately UNGATED — a rollback that
# waits on an eval run is not a rollback. usage: rollback.sh <alias> <env>
set -euo pipefail
if [ $# -ne 2 ]; then
  echo "usage: rollback.sh <alias> <env>"
  exit 2
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO/apps/worker"
./node_modules/.bin/tsx src/evals/promote.ts rollback "$1" "$2"
