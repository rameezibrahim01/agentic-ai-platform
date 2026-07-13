# Phase 4 exit drills — record

Phase 4 (build-plan): the enterprise wrap. Same discipline as phases 1–3:
drills are runs, not assertions; human-owned rows stay OPEN until signed.
Batch 031–035 covered the single-tenant-honest slice; batch 036–039 added
tenancy, so the onboarding drill now runs in REFERENCE FORM in CI — the
halves that need a real IdP, SCIM, or a real second customer stay
human-owned below.

## The drill map

| # | Drill | Executable form | Status |
|---|-------|-----------------|--------|
| 1 | Audit export (tamper evidence) | `drill-p4-1-audit-export.sh` | CI ✅ |
| 2 | Key revocation | `drill-p4-2-key-revocation.sh` | CI ✅ |
| 3 | SIEM test | customer's security team ingests + answers the auditor's question from THEIR tooling | **OPEN** (human) |
| 4 | Onboarding test | reference form: `drill-p4-3-onboarding.sh`; SSO/SCIM + real customer half | CI ✅ / **OPEN** (human) |
| 5 | Helm chart (k8s profile) | render floor: `drill-p4-4-helm-render.sh`; real `helm install` half | CI ✅ / **OPEN** (human) |

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

Per-tenant keys landed with tenancy (036); the key's SOURCE is deliberately
the client's problem (env/mounted secret is the interface).

**Rotation (ticket 043):** revoke, rotate, and restore are all operator
moves now. `OLD_DATA_KEY=<hex> NEW_DATA_KEY=<hex> tsx src/rotate-key-cli.ts
[--tenant <id>] [--dry-run]` re-encrypts a store's history under the new
key — per-run atomic under the same lock as append, decoded streams
verified byte-identical before commit, resumable if interrupted, typed
failure (nothing written) on a wrong old key. An unset `OLD_DATA_KEY`
adopts encryption over a plaintext store; an unset `NEW_DATA_KEY` decrypts
back out. Restart workers/console onto the new key before rotating.

## Drill 4 — onboarding, reference form (ticket 039)

**What runs (CI, against the real compose artifact):** the platform boots
tenanted with `acme` only (own schema `tenant_acme`, own task queue
`agent-runs--acme`, own data key `ACME_DATA_KEY`) and acme's first governed
write completes, encrypted, in its own schema. Then `globex` is onboarded
**by editing `deploy/tenants.config.json` and restarting worker+console —
the only vendor-side step is configuration**, which is the claim under
test. globex's first governed run completes on its own queue into its own
schema under its own key, and isolation is asserted four ways:

1. **storage** — each `tenant_*` schema holds only its own runs (psql);
2. **engine** — each demo run demonstrably rode its own task-queue lane;
3. **console** — a session bound to acme lists no globex runs and gets
   "run not found" on globex's runId (session scoping, ticket 038);
4. **key** — globex's raw rows are AES-256-GCM envelopes with no plaintext
   markers, encrypted under globex's own key, unreadable to any other.

Every pre-existing drill still boots single-tenant (the compose default is
untenanted; the drill opts in with `TENANTS_CONFIG`), so nothing regressed.

**What stays human (the drill's other half):** SSO/SCIM against the
customer's real IdP, and a REAL second customer going contract → first
governed run with zero vendor-side manual steps beyond config. Recorded
OPEN below until it happens.

## Drill 5 — the Helm chart, render floor (ticket 049)

**What runs (CI):** `helm lint` clean; `helm template` renders the default
(untenanted) values AND a tenanted+SCIM values file; the rendered manifests
are checked for the invariants that matter — secrets appear ONLY as
secretKeyRef names (a material-shaped string fails the drill), config mounts
sit at the exact compose paths, the untenanted default carries no
TENANTS_CONFIG, an unset optional secret renders no env var at all, and the
strict values schema refuses a typo'd key instead of deploying it.
Postgres/Temporal are client-provided endpoints by design; offline installs
are documented in `deploy/helm/AIRGAP.md`.

**What stays human:** the real `helm install` against a client cluster (a
kind-cluster CI install is a follow-up when CI minutes allow).

## Human-owned rows

| Drill | Owner | Status |
|-------|-------|--------|
| 3 — SIEM ingestion confirmed by the customer's security team | customer | **OPEN** |
| 4 — onboarding test, real form (SSO/SCIM, a real second customer) | owner + customer | **OPEN** (reference form CI ✅) |
| 5 — `helm install` on a client cluster (kind-cluster CI install is a follow-up) | owner + client infra | **OPEN** (render floor CI ✅) |
