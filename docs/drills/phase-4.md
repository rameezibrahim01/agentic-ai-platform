# Phase 4 exit drills — record

Phase 4 (build-plan): the enterprise wrap. Same discipline as phases 1–3:
drills are runs, not assertions; human-owned rows stay OPEN until signed.
This batch (031–035) covers the single-tenant-honest slice — the drills
that need a second tenant or a customer's SIEM stay human-owned below.

## The drill map

| # | Drill | Executable form | Status |
|---|-------|-----------------|--------|
| 1 | Audit export (tamper evidence) | `drill-p4-1-audit-export.sh` | CI ✅ |
| 2 | Key revocation | `drill-p4-2-key-revocation.sh` | CI ✅ |
| 3 | SIEM test | customer's security team ingests + answers the auditor's question from THEIR tooling | **OPEN** (human) |
| 4 | Onboarding test | second tenant, SSO/SCIM, zero vendor-side steps | **OPEN** (needs tenancy) |

## Drill 1 — the audit export

**What runs (CI):** a governed run log exports as a hash-chained stream in
all three formats; verification accepts the untouched stream and names the
first record on any single-field tamper (property-tested across every
record and field); a removed middle record breaks the chain; tail
truncation moves the head hash an auditor holds out-of-band; incremental
exports stitch into one verifiable chain; and who/what/when/on-whose-behalf/
under-which-rule is answerable from the NDJSON alone.

The CLI form: `tsx apps/worker/src/audit-export-cli.ts ndjson` against the
deployed store; the chain head prints to stderr for out-of-band recording.

## Drill 2 — key revocation

**What runs (CI, against the real compose artifact):** boot with a client
data key (`PLATFORM_DATA_KEY`) → the worker reports payload encryption ON →
a governed write executes → the raw `run_events` rows contain **no plaintext
markers** (agent, tool, note text, event types) and are visibly AES-256-GCM
envelopes → **revoke** (restart worker + console without the key): the run
is honestly absent from the console, reads are typed failures, and Temporal,
Postgres, and the console itself stay healthy → **restore** the key and
everything reads again. The key never appears in logs/events/traces — the
022 secrets scan runs its entire pass over an encrypted store with a seeded
key in the scan list.

Per-tenant keys and KMS sourcing arrive with tenancy; the key's SOURCE is
deliberately the client's problem (env/mounted secret is the interface).

## Human-owned rows

| Drill | Owner | Status |
|-------|-------|--------|
| 3 — SIEM ingestion confirmed by the customer's security team | customer | **OPEN** |
| 4 — onboarding test (second tenant via SSO/SCIM) | owner + tenancy work | **OPEN** |
