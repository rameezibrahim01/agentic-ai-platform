#!/usr/bin/env bash
# Phase 2 drill 5 — the secrets scan: a full scripted pass with seeded
# credential material (provider key, tool secret, delegation signing secret,
# the minted token itself) followed by a scan of EVERY persisted event, log
# line, and trace attribute for the seeded values and known credential
# shapes. Zero hits — and the scanner proves it can catch a leak (a
# deliberately-leaked fixture FAILs the scan).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill p2-5 (secrets scan)" 3 apps/worker/test/secrets-scan.test.ts
