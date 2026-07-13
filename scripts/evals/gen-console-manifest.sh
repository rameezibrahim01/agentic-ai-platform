#!/usr/bin/env bash
# Regenerate the console's eval manifest (ticket 055) from the worker's
# suite registry. The manifest is committed; a console test fails when it
# drifts, so "run this script" is the whole fix.
set -euo pipefail
cd "$(dirname "$0")/../.."

apps/worker/node_modules/.bin/tsx - <<'EOF' > apps/console/src/lib/eval-manifest.json
import { SUITES } from "./apps/worker/src/evals/cli.js";
console.log(JSON.stringify({ agentsWithSuites: SUITES.map((s) => s.agent.id) }, null, 2));
EOF

echo "wrote apps/console/src/lib/eval-manifest.json:"
cat apps/console/src/lib/eval-manifest.json
