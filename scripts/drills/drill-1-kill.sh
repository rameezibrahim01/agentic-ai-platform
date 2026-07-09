#!/usr/bin/env bash
# Exit drill 1 — the kill test: kill the worker mid-run; the run resumes from
# its event log and completes with zero duplicated events.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill 1 (kill test)" 1 apps/worker/test/workflow.test.ts -t "kill test"
