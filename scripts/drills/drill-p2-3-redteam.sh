#!/usr/bin/env bash
# Phase 2 drill 3 — red team (scripted half): embedded instructions in
# retrieved content cannot reach an out-of-grant tool; out-of-grant attempts
# are refused-and-audited by the engine; delegation scope attacks (wrong
# tool, higher risk, foreign principal, tampering, expiry) all die at the
# gateway. The HUMAN half — someone who wants it to fail — stays open in
# docs/drills/phase-2.md.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill p2-3a (embedded instructions vs grant)" 1 packages/tool-gateway/test/gateway.test.ts -t "red team"
run_vitest_drill "drill p2-3b (out-of-grant attempt — engine)" 1 apps/worker/test/approval.test.ts -t "out-of-grant"
run_vitest_drill "drill p2-3c (delegation scope attacks)" 6 packages/tool-gateway/test/delegation.test.ts
