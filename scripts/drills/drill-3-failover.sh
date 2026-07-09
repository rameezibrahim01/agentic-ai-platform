#!/usr/bin/env bash
# Exit drill 3 — the failover test: primary provider failure/timeout degrades
# to the fallback with no failure surfaced to the caller.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill 3a (gateway failover)" 4 packages/model-gateway/test/gateway.test.ts -t "failover"
run_vitest_drill "drill 3b (real-provider timeout failover)" 1 packages/model-gateway/test/anthropic.test.ts -t "fails over"
