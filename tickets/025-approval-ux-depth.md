# 025 — Approval UX depth: previews, SLA surfacing, safe batching

**Packages:** `apps/console` (viewmodels + inbox), `packages/core` (read-only helpers if needed) · **Depends on:** 017, 018 · **Allowed deps:** none new

## Context
Architecture §8 and build-plan Phase 2(e): the approval inbox is what enterprise buyers judge — and an inbox nobody can read quickly is a policy engine that silently times out to deny. Three honest gaps remain after 018: approvers see raw args instead of a *preview* of what will change; nothing surfaces an approval about to expire (expiry = deny, so silence has a cost); and ten similar low-risk writes demand ten identical clicks, which trains approvers to stop reading. All of this is console/viewmodel work over the existing event log — **no new event types, no engine changes**: every decision is still one signal per run, recorded per run.

## Scope
1. **Mutation preview** (`apps/console/src/lib/preview.ts`, pure + unit-tested): render a pending intent as a field-by-field preview — tool, version, risk tier, rule that fired, and a diff-style rendering of update-shaped args (`{ id, changes: {...} }` and flat objects render as `field: → value` rows; unknown shapes fall back to pretty-printed JSON, never hidden). Args are rendered as **data with provenance, never markdown/HTML** (CLAUDE.md #6 — an intent argument must not be able to style itself into looking approved).
2. **SLA surfacing**: `pendingApprovalsView` rows gain `expiresAt`-derived state (`ok` / `expiring_soon` (<25% ttl remaining) / `expired-pending-deny`) computed against injected `now`; the inbox sorts soonest-to-expire first and renders the state plainly.
3. **Safe batching**: group pending rows by `(agent, tool@version, risk)` into changesets; a changeset approve is offered **only** for `read`/`write` tiers (never `irreversible`/`financial` — those stay one-by-one by construction, not convention) and fans out to one `approvalDecision` signal per run with the same approver + comment, so the audit trail stays per-run. Partial failures are reported per run, not swallowed.
4. **Deny-with-reason parity**: the deny path gets the same preview + comment affordances (a deny without a legible reason is an audit hole).
5. Tests: preview rendering across arg shapes (including adversarial strings — script tags, ANSI, markdown — shown inert); SLA state boundaries (property over ttl); batching group-by and the tier ceiling; fan-out signalling unit-tested with an injected signal function.

## Out of scope
Notification routing (Slack/email/push), escalation to other approver groups (needs an event-model design — new issue when scoped), true before/after diffs fetched from target systems, mobile layout, approval delegation to another named person.

## Acceptance criteria
- [ ] A pending write renders as a field-level preview with tool, tier, and firing rule; adversarial argument content renders inert (test-pinned).
- [ ] Inbox rows carry SLA state from the log's `expiresAt` alone, soonest-first; `expiring_soon` boundary property-tested.
- [ ] Changeset approval exists for read/write only; irreversible/financial can never batch (enforced in the viewmodel type, tested); every batched decision lands as one per-run signal with the approver recorded.
- [ ] No new event types; replaying old logs renders identically.
- [ ] `pnpm test` and `pnpm build` green.
