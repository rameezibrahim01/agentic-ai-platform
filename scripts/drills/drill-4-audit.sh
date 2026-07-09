#!/usr/bin/env bash
# Exit drill 4 (log half) — the audit test: for any run id the console
# reconstructs every step with tokens and cost, and totals equal the
# reducer's exactly. (The other half — totals vs the provider invoice within
# 2% — is human-owned; see docs/drills/phase-1.md.)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill 4 (audit reconstruction)" 6 apps/console/test/viewmodels.test.ts
