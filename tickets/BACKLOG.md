# Backlog — next batches

## Batch 006–010 — EXPANDED into ticket files ✔ (all merged)
## Batch 011–013 — EXPANDED into ticket files (see tickets/011…013) ✔

## Then: Phase 1 exit
With 011–013 done: run `scripts/drills/run-all.sh`, record results in `docs/drills/phase-1.md`,
obtain the human-owned sign-offs (drill 5 usefulness; invoice reconciliation). Only then open
Phase 2 (tool registry, tool gateway, risk tiers, policy engine, approval inbox, identity
delegation, trigger subsystem) per `docs/build-plan.md`.

## Batch 014–018 (Phase 2 spine) — EXPANDED into ticket files ✔
Note: expanded on owner authorization while the two human-owned Phase 1 sign-offs
(usefulness, invoice reconciliation) remain open in docs/drills/phase-1.md.

## Batch 019–022 — EXPANDED into ticket files (see tickets/019…022) ✔

## Batch 023–025 — EXPANDED into ticket files (see tickets/023…025) ✔
Note: 025 deliberately defers approval escalation/delegation-to-a-person (needs an
event-model design — becomes a type:design issue when scoped) and notification routing.

## Batch 026–030 (Phase 3 spine) — EXPANDED into ticket files (see tickets/026…030) ✔
Note: expanded on owner authorization while Phase 2's human-owned rows (partner's real
write, external red-team review) and Phase 1's two sign-offs remain open. Automated
canary stays deliberately deferred per build-plan's "safe to cut" — 028 lands manual
promotion gated on green evals + ungated one-command rollback instead.

## Batch 031–035 (Phase 4, deployable slice) — EXPANDED into ticket files (see tickets/031…035) ✔
Scoped to what is honest single-tenant: tamper-evident audit export (031), retention +
legal hold (032), kill switches/caps/rate limits (033), OIDC SSO federation (034),
client-key payload encryption + revocation drill (035). Tenancy hardening, SCIM, Helm/
air-gap packaging, and per-tenant keys stay seeded below — they need tenancy or k8s
surfaces this codebase doesn't have yet.

## Batch 036–039 (tenancy hardening) — EXPANDED into ticket files (see tickets/036…039) ✔ (all merged)
The domino batch, landed: schema-per-tenant storage (036), tenant-scoped engine lanes
(037), tenant-bound console sessions (038), and the onboarding drill in reference form
(039, `drill-p4-3-onboarding.sh` — the SSO/SCIM + real-customer half stays human-owned
in docs/drills/phase-4.md).

## Batch 040–044 (enterprise ops) — EXPANDED into ticket files (see tickets/040…044) ✔
SCIM provisioning floor (040), per-tenant model/tool configs (041), platform-operator
view (042), key rotation/re-encryption (043), run_scores retention parity (044).
Deferred within the batch: per-tenant provider API keys (needs a secrets-mount design),
SCIM Groups, operator write actions.

## Batch 045–048 (governed operations) — EXPANDED into ticket files (see tickets/045…048) ✔
Read-only SQL tool (045, architecture §6's escape hatch), per-tenant provider API
keys (046), kill-switch write path with ops audit (047), approval escalation (048).

## Batch 049–051 (the last machine-checkable seeds) — EXPANDED into ticket files ✔
Helm chart + air-gap docs, render-verified floor (049); delegation-to-a-person (050);
approval notifications, webhook floor (051).

## Batch 052–056 (the authoring layer) — EXPANDED into ticket files (see tickets/052…056)
Owner direction after 051: every discussed path (internal departments, government, partner
demos) needs the same next surface — create/run/observe agents from the browser. Registry
read pages (052), the builder write path on the 047 pattern (053), the run launcher (054),
promote/rollback with the honest "unproven" marker (055), and the machine-checked walkthrough
+ GETTING-STARTED.md (056). Deferred within the batch: per-tenant agent registries, operator
cross-tenant launches, run cancel, eval authoring UI.

## Batch 057–060 (the connector layer) — EXPANDED into ticket files (see tickets/057…060)
Owner direction after the authoring layer ("what next to be implemented?"): agents that touch
real department systems, the common denominator of every candidate market. File & spreadsheet
connector with one governed write (057), email connector with a domain-allowlisted governed
send (058), curated agent templates in the builder (059), and the department demo — drill +
GETTING-STARTED part 2 (060). Deferred within the batch: PDF/XLSX extraction, OAuth
mailboxes, attachments, live-mail drill (HUMAN row), per-tenant connector roots.

## What remains after the authoring layer — needs things only humans can provide
- **Human-owned drill rows** (docs/drills/phase-{1..4}.md): design-partner usefulness
  sign-off, invoice reconciliation, the partner's REAL write, external red-team review,
  model-swap + economics reads, customer SIEM ingestion, real SSO/SCIM onboarding.
- **A real cluster**: `helm install` against a client k8s (049 ships the render-verified
  chart; a kind-cluster CI install is a type:design issue when CI minutes allow).
- **A partner's requirements**: SQL schema allowlists/column masking (045 note),
  per-tenant notification configs (051 note), connector SDK docs shaped by the first
  third-party tool author.
- **Phase 3 drills still OPEN in docs/drills/phase-3.md:** model-swap (needs a successor
  model + real key), economics test (human-read from /costs).
- **Connector SDK docs** + scoped read-only SQL tool (architecture §6's remaining
  escape hatch) — follow-ups to 030.
- The partner's REAL write (drill 1's true form) and the external red-team review remain
  human-owned; sandbox pool stays deferred until the partner workflow needs code execution.
