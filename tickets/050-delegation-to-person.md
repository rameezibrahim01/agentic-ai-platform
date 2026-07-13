# 050 — Delegation to a person: a pending approval hands to a named principal

**Packages:** `packages/core` (event) + `apps/console` (action + gate) · **Depends on:** 025, 048 · **Allowed deps:** none new

## Context
048 escalated to GROUPS; the deferred half is a person: "Omar is on call for this one" is a delegation to a principal, recorded in the log, and — the part that matters — the delegate may then DECIDE even if their roles alone wouldn't admit them to the inbox's decision forms. Same doctrine as everything else: the event is the fact, the console is the gate, and the audit's `who` is the human who clicked.

## Scope
1. `packages/core`: additive `ApprovalDelegated { toPrincipal, by }` — legal only in `awaiting_approval`, records `delegatedTo` on the pending approval (coexists with 048's `escalatedTo`), changes nothing else; generator + property coverage like 048.
2. Console delegate action: `POST /api/approvals/[runId]/delegate` — requires `approve_intents` (you may hand off only what you could decide), body names the principal; appends the event via a new idempotent `recordDelegation` path — console-side this is a store append through the same 038 tenant gating as decisions (no signal; delegation doesn't wake the workflow, it changes who may). Refusals typed; everything session-scoped.
3. The decision gate widens exactly one notch: `mayDecide(session, row)` (pure) = `can(roles, "approve_intents")` OR `session.principal === row.delegatedTo`. The approval POST routes use it; the inbox shows decision forms accordingly and displays "delegated to <principal> by <who>".
4. Workflow untouched: decisions still arrive as the same signal; the delegate's decision records their principal as `by` (the audit already does this).
5. Tests: reducer legality/additivity/coexistence-with-escalation properties; `mayDecide` matrix (approver yes, delegate-without-role yes on THEIR run only, viewer no); route-level delegation flow over injected deps incl. tenant gating (A cannot delegate B's run) and the no-append-on-refusal pin; inbox viewmodel from the log alone.

## Out of scope
Delegation chains (one hop; re-delegation by the delegate requires approve_intents like anyone), delegation expiry (the approval's own expiry governs), notification of the delegate (051), cross-tenant delegation (sessions are tenant-bound; the store gate already forbids it).

## Acceptance criteria
- [ ] `ApprovalDelegated` additive; pre-050 logs replay unchanged; legality + state property-tested (incl. alongside escalation).
- [ ] A delegate without approver roles can decide exactly the run delegated to them — and nothing else (matrix test-pinned).
- [ ] Delegation is session-tenant-gated like decisions; refused delegations append nothing.
- [ ] Inbox shows delegation computed from the log alone.
- [ ] `pnpm test`, `pnpm build`, console Next build green.
