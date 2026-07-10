#!/usr/bin/env bash
# The eval gate (ticket 028): every agent's golden suite through the real
# pipeline. Nonzero on any red scenario — CI treats it like a failing test.
# Optional: --agent <name@vN> narrows to one agent (promote.sh's gate).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO/apps/worker"
exec ./node_modules/.bin/tsx src/evals/cli.ts "$@"
