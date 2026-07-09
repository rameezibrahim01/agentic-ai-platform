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

## Phase 2, next seeds (expand when 014–018 are done)
- **019 — Identity & delegation:** workload identity per agent per env, token exchange,
  delegated time-boxed credentials for runs acting for a user (architecture §7).
- **020 — Standing delegation grants + trigger subsystem:** run templates as objects,
  event triggers, standing grants (named tools, mandatory expiry, revocation, audited use);
  the 2 a.m. exit drill.
- **021 — First real write tool + MCP wrapping:** partner-workflow write action behind the
  gateway; diff-style mutation preview in the inbox; the "first approved write in prod" drill.
- **022 — Secrets-scan drill + red-team rerun:** automated scan of all logged prompts/completions
  (Phase 2 drills 5 & 3 as recorded scripts, extending scripts/drills/).
- Sandbox pool stays deferred until the partner workflow needs code execution (build-plan cut list).
