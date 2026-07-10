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

## Phase 2 exit / Phase 3 seeds (expand when 023–025 are done)
- With 023–025 done, Phase 2's machine-checkable surface is complete; the gate then
  waits on the human-owned rows (partner's real write, external red-team review) in
  docs/drills/phase-2.md — plus the two Phase 1 sign-offs still open.
- **Phase 3 spine (per docs/build-plan.md):** eval harness (golden suites harvested
  from real traces), CI gating on prompt/config/model changes, versioning + promotion
  with one-click rollback, canary + online sampling, cost-per-outcome dashboards,
  connector scale kit (OpenAPI→tool generator, connector SDK).
- Real ANTHROPIC_API_KEY wiring for the worker (007's provider into the artifact,
  key from env/secret only) remains a small standalone seed.
- The partner's REAL write (drill 1's true form) and the external red-team review remain
  human-owned; sandbox pool stays deferred until the partner workflow needs code execution.
