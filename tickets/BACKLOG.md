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

## Phase 2, remaining seeds (expand when 019–022 are done)
- **023 — Run templates + event triggers:** templates as saved shareable objects with
  view/edit/trigger grants; registered-webhook event triggers, governed like any object.
- **024 — MCP transport:** wrap an external MCP server as executors behind the tool
  gateway — the moment it is wrapped it inherits the entire governance stack (architecture §6).
- **025 — Approval UX depth:** diff-style mutation previews, sane batching of low-risk
  changesets, delegation/escalation on SLA breach.
- The partner's REAL write (drill 1's true form) and the external red-team review remain
  human-owned; sandbox pool stays deferred until the partner workflow needs code execution.
