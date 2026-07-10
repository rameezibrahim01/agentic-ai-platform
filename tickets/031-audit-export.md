# 031 — Tamper-evident audit export to SIEM formats

**Packages:** new `packages/audit-export` (pure) + `apps/worker` (CLI glue), `scripts/drills/` · **Depends on:** 006, 022 · **Allowed deps:** none new

## Context
Build-plan Phase 4(c): enterprise buyers need the audit stream in *their* tooling. The run event log is already append-only; the export makes that property portable — every exported record carries a hash chained to its predecessor, so truncation or tampering of the exported stream is detectable by anyone holding the head hash, without trusting the exporter. "WORM" is delivered honestly: an integrity-chained export plus verification, not a claim about media.

## Scope
1. `packages/audit-export`: `exportRuns(store, opts)` → ordered export records `{ seq, runId, event, prevHash, hash }` where `hash = sha256(prevHash + canonical(record body))`, genesis from a caller-supplied anchor; `verifyExportChain(records, anchor)` → typed ok/broken-at.
2. Formatters, pure: NDJSON (the neutral baseline), Splunk HEC envelope (`{ time, host, source, sourcetype, event }`), Datadog logs envelope (`{ ddsource, service, timestamp, message: <event JSON> }`) — all deriving from the same chained records, timestamps ISO-8601 UTC.
3. `apps/worker/src/audit-export-cli.ts`: `tsx src/audit-export-cli.ts <format> [--since-seq]` — reads the configured store, writes to stdout, prints the chain head hash to stderr (the value an auditor records out-of-band).
4. Incremental export: `--anchor <hash>` continues a previous export's chain, so periodic shipping to a SIEM keeps one unbroken chain across invocations.
5. `scripts/drills/drill-p4-1-audit-export.sh`: seeded store → export NDJSON → `verifyExportChain` passes → flip one byte in one record → verification names the broken record → the auditor's question (022) is answerable from the exported NDJSON alone (grep-level check). Recorded in `docs/drills/phase-4.md` (started here).

## Out of scope
Live streaming/webhooks to SIEMs (batch export only), SIEM-side dashboards, retention (032), tenant scoping (no tenants yet), actual WORM media.

## Acceptance criteria
- [ ] Export records are hash-chained; `verifyExportChain` accepts the untouched stream and names the first broken record on any single-byte tamper (property-tested).
- [ ] NDJSON, Splunk HEC, and Datadog formats derive from identical chained records; timestamps ISO-8601 UTC.
- [ ] Incremental export with `--anchor` produces one verifiable chain across invocations.
- [ ] Drill p4-1 passes in CI and the auditor's question is answerable from the export alone.
- [ ] `pnpm test` and `pnpm build` green.
