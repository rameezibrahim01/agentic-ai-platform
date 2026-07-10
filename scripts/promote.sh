#!/usr/bin/env bash
# Promotion (ticket 028): move an environment pointer — GATED on the target
# version's golden suite passing right now. usage: promote.sh <alias> <version> <env>
set -euo pipefail
if [ $# -ne 3 ]; then
  echo "usage: promote.sh <alias> <name@vN> <env>"
  exit 2
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "== promotion gate: running the suite for $2 =="
bash "$REPO/scripts/evals/run-evals.sh" --agent "$2"
cd "$REPO/apps/worker"
./node_modules/.bin/tsx src/evals/promote.ts promote "$1" "$2" "$3"
