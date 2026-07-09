#!/usr/bin/env bash
# Exit drill 6 — the schedule test: timezone-pinned firing, skip-if-running
# overlap, explicit catch-up policy — chosen behavior, not accidental.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill 6 (schedules)" 3 apps/worker/test/schedules.test.ts
