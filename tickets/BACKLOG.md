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

## Phase 3 remainder / Phase 4 seeds (expand when 026–030 are done)
- **Phase 3 drills** to record in docs/drills/phase-3.md as they become executable:
  bad-prompt test (028), model-swap drill (one command re-evals every agent against a
  successor model — needs 026+028), economics test (029's /costs — human-read).
- **Connector SDK docs** + scoped read-only SQL tool (architecture §6's remaining
  escape hatch) — follow-ups to 030.
- **Phase 4 spine (per docs/build-plan.md):** SSO/SCIM federation of the 013 accounts,
  tenancy hardening, WORM audit export to SIEMs, BYOK + key-revocation drill, Helm/
  air-gap packaging of the artifact, retention + legal hold, tenant-level budgets and
  kill switches.
- The partner's REAL write (drill 1's true form) and the external red-team review remain
  human-owned; sandbox pool stays deferred until the partner workflow needs code execution.
