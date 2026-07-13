# 048 — Approval escalation: silence climbs the ladder before it denies

**Packages:** `packages/core` (event) + `apps/worker` (workflow) + `apps/console` (inbox) · **Depends on:** 017, 025 · **Allowed deps:** none new

## Context
025 gave expiry teeth (expiry = deny, silence has a cost) and deferred escalation pending an event-model design. The design: escalation is a FACT in the run's log, not a notification side effect. A pending approval may name an escalation — after a fraction of its TTL, the request is re-addressed to a fallback group, visibly, in the event log; the original expiry still stands (escalation buys attention, never time). Additive event type only — every existing log replays unchanged (CLAUDE.md #5).

## Scope
1. `packages/core`: new event `ApprovalEscalated { toGroup, at, seq, runId }` (additive to the union); reducer — legal only in `awaiting_approval`, keeps the status, records `escalatedTo` on the pending approval state; illegal placements are reducer errors like any other misplaced event. Property tests extend the event-model suite.
2. Workflow (`apps/worker`): `AgentRunInput` gains optional `escalation: { toGroup, afterMs }` (zod-validated; `afterMs` must be < approvalTtlMs). While awaiting approval, a second timer races decision/expiry: at `afterMs`, an idempotent `recordEscalation` activity appends `ApprovalEscalated` and the wait continues to the ORIGINAL expiry. Decision-before-escalation → no escalation event; expiry semantics byte-identical (an escalated-then-silent run still auto-denies on time).
3. Console inbox: escalated rows show "escalated to <group>" with the SLA state (the 025 view already recomputes from the log; extend the view model, not the page's trust).
4. Templates/triggers pass `escalation` through unchanged where they already pass approval settings.
5. Tests: reducer property (escalation only in awaiting_approval; state records it; replay determinism holds); Temporal suite — escalation fires at afterMs then approval still executes on grant / denies on expiry, decision-first yields no escalation event, dedup on activity retry (idempotent append); inbox view model shows escalation from the log alone.

## Out of scope
Notification delivery (email/slack routing is deployment wiring — the LOG is the contract; a `type:design` issue when a partner needs push), delegation-to-a-person (a person is a principal, not a group — separate design), multi-step ladders (one escalation hop; ladders are config sugar later), escalation for batch changesets.

## Acceptance criteria
- [ ] `ApprovalEscalated` is additive: every pre-048 log replays byte-identically; reducer legality + state recording property-tested.
- [ ] Temporal-pinned: escalation fires once at `afterMs` (idempotent under retry), original expiry unchanged, decision-first suppresses it.
- [ ] Inbox shows escalation computed from the log alone.
- [ ] `pnpm test`, `pnpm build`, console Next build green.
