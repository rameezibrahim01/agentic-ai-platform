#!/usr/bin/env bash
# Phase 2 drill 2 — the environment split: the IDENTICAL write intent
# auto-executes in dev and pauses for approval in prod, at every layer —
# policy unit (015), tool gateway (016), and the engine end-to-end (018).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill p2-2a (policy env split — unit)" 1 packages/policy/test/policy.test.ts -t "environment split"
run_vitest_drill "drill p2-2b (gateway env split)" 1 packages/tool-gateway/test/gateway.test.ts -t "environment split"
run_vitest_drill "drill p2-2c (engine env split — Temporal)" 1 apps/worker/test/approval.test.ts -t "environment split"
