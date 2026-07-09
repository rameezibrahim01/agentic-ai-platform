# 020 — Standing delegation grants + the 2 a.m. drill

**Packages:** `packages/identity` (grants) + `apps/worker` (schedule wiring) · **Depends on:** 010, 019 · **Allowed deps:** none new

## Context
Architecture §7: scheduled runs break the live-session assumption — at 2 a.m. there is no user to exchange a token from. A **standing delegation grant** is a first-class, auditable object in which a user pre-authorizes a specific schedule to act as them: named tools, risk ceiling, **mandatory expiry**, one-click revocation, every exercise logged. What is never acceptable is a scheduler quietly running on a stored admin credential.

## Scope
1. `StandingGrant` in `packages/identity`: `{ id, principal, scheduleId, tools: ToolRef[], risks: RiskTier[], expiresAt, revokedAt? }` — zod-validated; expiry is required at construction (no unexpiring grants exist, by type).
2. `GrantStore` (interface + in-memory): `create` (refuses missing expiry), `get`, `revoke(id, at)`, `listForSchedule`.
3. `exerciseGrant(grant, { runId, agent, env }, ttlMs, secret, nowMs)` → typed result: refuses `revoked` / `expired`; success mints a per-occurrence delegation (019) time-boxed to min(ttl, grant expiry) and returns `{ delegation, exercise }` where `exercise` is an audit record `{ grantId, principal, scheduleId, runId, at }`.
4. Schedule wiring: `AgentScheduleSpec.standingGrantId?`; each occurrence resolves the grant in a **`resolveStandingGrant` activity** at run start — valid → delegation injected into the run's intents and the exercise appended to the run log inside `RunStarted.input.grantExercise` (no new core event type; the exercise is part of the run's audited input); revoked/expired → the run proceeds **without** a delegation, so every governed intent is refused at the gateway's delegation check — halting at the policy layer, never falling back to a broader credential.
5. The **2 a.m. drill** as tests: a scheduled occurrence executes a governed (write, delegation-required) action end-to-end under a standing grant with the exercise auditable; after `revoke`, the next occurrence's intents are refused with `gateway:delegation_missing` in the log and the run still completes/records cleanly.

## Out of scope
Grant management UI, notification of expiring grants, per-grant argument constraints, event triggers/webhooks, persistence beyond in-memory + config.

## Acceptance criteria
- [ ] Grants cannot be constructed without expiry (compile + runtime); revocation is one call and permanent.
- [ ] `exerciseGrant`: valid → delegation whose scope equals the grant's and whose expiry never exceeds the grant's; revoked/expired → typed refusal, no delegation minted.
- [ ] 2 a.m. drill (CI-authoritative): scheduled occurrence + standing grant → governed write executes with the grant exercise recorded in the run's audited input and the delegated principal in the log.
- [ ] Revocation drill: after `revoke`, the next occurrence's governed intents are refused at the delegation check (`gateway:delegation_missing`) — audited, no broader credential, run survives.
- [ ] `pnpm test` and `pnpm build` green.
