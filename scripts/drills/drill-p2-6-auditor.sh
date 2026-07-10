#!/usr/bin/env bash
# Phase 2 drill 6 — the auditor's question: for a given run id, ONE command
# reconstructs who acted, what they did, when, on whose behalf, and under
# which rule — from the event log alone, wall-clock well under a minute.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

start=$(date +%s)
run_vitest_drill "drill p2-6 (auditor's question)" 3 apps/console/test/audit.test.ts
elapsed=$(( $(date +%s) - start ))
if [ "$elapsed" -ge 60 ]; then
  echo "FAIL: the auditor's question took ${elapsed}s — must be well under a minute"
  exit 1
fi
echo "PASS: auditor's question answered in ${elapsed}s"
