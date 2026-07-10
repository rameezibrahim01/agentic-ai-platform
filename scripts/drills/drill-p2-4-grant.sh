#!/usr/bin/env bash
# Phase 2 drill 4 — grants: the gateway's grant check (016), standing grant
# invariants (mandatory expiry, permanent revocation, expiry-capped
# delegations, 020), and the engine drills (2 a.m. + revocation) that prove
# a revoked grant halts the next occurrence at the policy layer.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill p2-4a (gateway grant check)" 1 packages/tool-gateway/test/gateway.test.ts -t "grant test"
run_vitest_drill "drill p2-4b (standing grant invariants)" 6 packages/identity/test/grants.test.ts
run_vitest_drill "drill p2-4c (2 a.m. + revocation — engine)" 5 apps/worker/test/grants.test.ts
