#!/usr/bin/env bash
# Phase 1 exit-drill harness (ticket 012): run every machine-checkable drill,
# print a drill-by-drill summary, exit nonzero if any fails. Drills 5 and the
# invoice half of 4 are human-owned — see docs/drills/phase-1.md.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
declare -a NAMES=(
  "drill 1 — kill test"
  "drill 2 — budget test"
  "drill 3 — failover test"
  "drill 4 — audit test (log half)"
  "drill 6 — schedule test"
  "drill 7 — artifact test"
)
declare -a SCRIPTS=(
  "drill-1-kill.sh"
  "drill-2-budget.sh"
  "drill-3-failover.sh"
  "drill-4-audit.sh"
  "drill-6-schedule.sh"
  "drill-7-artifact.sh"
)

declare -a RESULTS=()
failures=0
for i in "${!SCRIPTS[@]}"; do
  echo ""
  echo "=== ${NAMES[$i]} ==="
  if bash "${DIR}/${SCRIPTS[$i]}"; then
    RESULTS+=("PASS  ${NAMES[$i]}")
  else
    RESULTS+=("FAIL  ${NAMES[$i]}")
    failures=$((failures + 1))
  fi
done

echo ""
echo "================ PHASE 1 EXIT DRILLS ================"
for line in "${RESULTS[@]}"; do
  echo "$line"
done
echo "HUMAN  drill 5 — usefulness test (design partner, weekly)"
echo "HUMAN  drill 4 — invoice reconciliation (totals within 2%)"
echo "====================================================="

if [ "$failures" -gt 0 ]; then
  echo "RESULT: ${failures} machine-checkable drill(s) FAILED"
  exit 1
fi
echo "RESULT: all machine-checkable drills PASSED"
