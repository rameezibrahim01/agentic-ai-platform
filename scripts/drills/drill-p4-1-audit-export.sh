#!/usr/bin/env bash
# Phase 4 drill 1 — the audit export: the run log leaves the platform as a
# hash-chained stream (NDJSON / Splunk HEC / Datadog); verification accepts
# the untouched stream, names the first tampered record, and the auditor's
# question is answerable from the export alone.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
run_vitest_drill "drill p4-1 (tamper-evident audit export)" 6 packages/audit-export/test/export.test.ts
