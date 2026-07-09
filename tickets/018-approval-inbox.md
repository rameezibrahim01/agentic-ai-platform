# 018 — Approval inbox + the environment split

**Packages:** `apps/console` (+ `@platform/auth` action table) · **Depends on:** 013, 017 · **Allowed deps:** `@temporalio/client` in the console (signaling), nothing else new

## Context
Phase 2 workstream (e), product half: "this screen is what enterprise buyers judge." The inbox shows the full intent — what the agent wants to do, to what, on whose behalf, with which arguments — and approve/deny with comment. Plus the environment-split exit drill: the identical intent auto-executes in dev and demands approval in prod, by policy alone.

## Scope
1. `@platform/auth`: `can()` gains `approve_intents` (roles: `approver`, `platform_admin`) — exhaustive tests updated.
2. Console `/approvals` (guarded by `requireSession` + `approve_intents`):
   - lists runs whose replayed state is `awaiting_approval` with the full intent preview: tool `name@version`, risk tier, arguments (pretty-printed JSON), requesting agent, principal, requested-at, expires-at;
   - approve / deny forms (with optional comment) posting to route handlers that verify the role again server-side and send the ticket-017 signal as the signed-in principal (`by` = session principal — the audit's *who* is real);
   - viewers/auditors see the inbox read-only (no forms); non-approvers' POSTs are refused 403.
3. Runs table gains an `awaiting_approval` filter link so pending work is one click from the default view.
4. **Environment-split test** (unit + engine): identical write intent with `DEFAULT_RULES` — `env: dev` executes without approval events; `env: prod` pauses for approval (packages/policy already proves the decision; this proves the *behavior* end to end in the worker suite).
5. Verified against the running app: sign in as an approver, see the pending intent, approve it, watch the run complete (curl-driven, same pattern as 013).

## Out of scope
Batching, delegation/escalation/SLA, notification routing, diff-style mutation previews (arrives with real write tools), approval history page.

## Acceptance criteria
- [ ] `/approvals` requires a session AND the `approve_intents` action for mutations; viewers get read-only; anonymous → login.
- [ ] The inbox renders every pending intent's tool, version, risk, args, principal, and expiry from the event log (view-model unit tests, same discipline as 009).
- [ ] Approve and deny round-trips signal the workflow as the signed-in principal; the resulting `ApprovalGranted/Denied.by` in the log equals the session principal.
- [ ] Environment-split drill green in the worker suite: same intent, dev auto-executes, prod demands approval, policy alone decides.
- [ ] Verified against the running app (login → pending → approve → run completes); `pnpm test`, `pnpm build`, console `next build` green.
