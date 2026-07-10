#!/usr/bin/env bash
# Exit-drill harness (ticket 012, extended by 022): run every
# machine-checkable drill for both phases, print a drill-by-drill summary,
# exit nonzero if any fails. Human-owned drills are listed, never faked —
# see docs/drills/phase-1.md and docs/drills/phase-2.md.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
declare -a NAMES=(
  "phase 1 / drill 1 — kill test"
  "phase 1 / drill 2 — budget test"
  "phase 1 / drill 3 — failover test"
  "phase 1 / drill 4 — audit test (log half)"
  "phase 1 / drill 6 — schedule test"
  "phase 1 / drill 7 — artifact test"
  "phase 2 / drill 1 — reference write (artifact)"
  "phase 2 / drill 2 — environment split"
  "phase 2 / drill 3 — red team (scripted half)"
  "phase 2 / drill 4 — grants (incl. 2 a.m. + revocation)"
  "phase 2 / drill 5 — secrets scan"
  "phase 2 / drill 6 — auditor's question"
  "phase 4 / drill 1 — audit export (tamper evidence)"
  "phase 4 / drill 2 — key revocation (artifact)"
)
declare -a SCRIPTS=(
  "drill-1-kill.sh"
  "drill-2-budget.sh"
  "drill-3-failover.sh"
  "drill-4-audit.sh"
  "drill-6-schedule.sh"
  "drill-7-artifact.sh"
  "drill-p2-1-write.sh"
  "drill-p2-2-envsplit.sh"
  "drill-p2-3-redteam.sh"
  "drill-p2-4-grant.sh"
  "drill-p2-5-secrets-scan.sh"
  "drill-p2-6-auditor.sh"
  "drill-p4-1-audit-export.sh"
  "drill-p4-2-key-revocation.sh"
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
echo "================ EXIT DRILLS (PHASES 1 + 2) ================"
for line in "${RESULTS[@]}"; do
  echo "$line"
done
echo "HUMAN  phase 1 / drill 5 — usefulness test (design partner, weekly)"
echo "HUMAN  phase 1 / drill 4 — invoice reconciliation (totals within 2%)"
echo "HUMAN  phase 2 / drill 1 — the partner's REAL write (reference form runs above)"
echo "HUMAN  phase 2 / drill 3 — external red-team review (a person, not a script)"
echo "============================================================"

if [ "$failures" -gt 0 ]; then
  echo "RESULT: ${failures} machine-checkable drill(s) FAILED"
  exit 1
fi
echo "RESULT: all machine-checkable drills PASSED"
