#!/usr/bin/env bash
# Exit drill 2 — the budget test: an adversarial looping prompt is terminated
# by loop detection; a cost cap trips at the correct step, engine-enforced.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill 2a (adversarial loop)" 1 apps/worker/test/workflow.test.ts -t "adversarial loop"
run_vitest_drill "drill 2b (cost cap)" 1 apps/worker/test/workflow.test.ts -t "cost cap"
run_vitest_drill "drill 2c (budget/loop core properties)" 9 packages/core/test/budget.test.ts
