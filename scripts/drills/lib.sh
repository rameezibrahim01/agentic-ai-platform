#!/usr/bin/env bash
# Shared helper for Phase 1 exit drills. A drill PASSES only when the expected
# number of tests actually PASSED — environment-skipped tests (missing
# ephemeral Temporal server, no Docker) are a loud FAIL with the reason, never
# a fake pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

run_vitest_drill() {
  local desc="$1"
  local expected_passed="$2"
  shift 2
  local out
  if ! out=$(cd "$REPO_ROOT" && pnpm vitest run "$@" 2>&1); then
    echo "FAIL: ${desc} — test run failed"
    echo "$out" | tail -40
    return 1
  fi
  local passed
  # the "Tests" summary line, not the "Test Files" one
  passed=$(echo "$out" | grep -E "^[[:space:]]*Tests[[:space:]]" | grep -oE "[0-9]+ passed" | head -1 | grep -oE "[0-9]+" || echo 0)
  if [ "${passed:-0}" -lt "$expected_passed" ]; then
    echo "FAIL: ${desc} — expected >= ${expected_passed} passing tests, saw ${passed:-0}."
    echo "      Likely environment-skipped (needs the ephemeral Temporal server or Docker);"
    echo "      this drill is authoritative in CI."
    return 1
  fi
  echo "PASS: ${desc} (${passed} tests)"
}
