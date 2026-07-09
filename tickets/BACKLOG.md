# Backlog — next batches

## Batch 006–010 — EXPANDED into ticket files ✔ (all merged)
## Batch 011–013 — EXPANDED into ticket files (see tickets/011…013) ✔

## Then: Phase 1 exit
With 011–013 done: run `scripts/drills/run-all.sh`, record results in `docs/drills/phase-1.md`,
obtain the human-owned sign-offs (drill 5 usefulness; invoice reconciliation). Only then open
Phase 2 (tool registry, tool gateway, risk tiers, policy engine, approval inbox, identity
delegation, trigger subsystem) per `docs/build-plan.md`.

## Phase 2 seeds (expand only after the Phase 1 gate)
- Tool registry: versioned MCP contracts, JSON-Schema both directions, risk tier per version.
- Tool gateway: grant checks, egress allowlist, server-side secret injection, audited invocations.
- Policy engine: allow / deny / require-approval with the rule recorded (start <10 rules).
- Approval inbox: full intent preview, diff rendering, expiry-to-deny, batching.
- Identity & delegation: workload identity, token exchange, standing delegation grants.
