# 013 — Sign-in floor + RBAC roles

**Packages:** new `packages/auth` + wiring in `apps/console` · **Depends on:** 009 · **Allowed deps (add in this ticket):** none new at runtime in `packages/auth` (Node `crypto`); console uses its existing Next.js stack

## Context
Build-plan Phase 1 workstream (e): "basic sign-in and the RBAC roles exist from this phase — the audit log's *who* depends on them. Local accounts are fine here; SSO federation and SCIM stay in Phase 4." Without principals, Phase 2's policy decisions and approvals have no subject. This is a floor, not an identity system: local accounts, five roles, signed sessions, principal strings that match the event model's `principal` field.

## Scope
1. `packages/auth` (`@platform/auth`, pure logic + Node crypto only):
   - `Role` = `platform_admin | agent_developer | approver | auditor | viewer` (architecture §3);
   - local account records `{ username, passwordHash (scrypt, per-user salt), roles }` + `verifyPassword` (constant-time compare) + `parseAccountsFile` (zod-validated JSON, e.g. mounted secret/seed file — never committed credentials, CLAUDE.md #4);
   - stateless session tokens: `issueSession(account, ttlMs, secret, nowMs)` → HMAC-signed payload; `verifySession(token, secret, nowMs)` → typed result (valid/expired/tampered) — clock injected, pure;
   - `principalFor(account)` → `user:<username>`, matching `RunStarted.principal`;
   - `can(role[], action)` — the Phase 1 permission floor: `view_runs` (all roles), `manage_platform` (admin only); the table grows in Phase 2.
2. Console wiring: `/login` (server action, sets httpOnly cookie), middleware guarding `/runs*` (no session → redirect to login), sign-out; the signed-in principal and roles rendered in the layout. Accounts from `AUTH_ACCOUNTS_FILE` (JSON path) with a dev fallback seed when unset; session secret from `AUTH_SESSION_SECRET` env.
3. Tests are the spec: password hashing round-trip + tamper/expiry cases for sessions (property-tested where sensible), `can` table exhaustive over roles, accounts-file validation failures typed.

## Out of scope
OIDC/SAML federation and SCIM (Phase 4), user management UI, password reset, per-object grants (Phase 2 ownership model), rate limiting, worker-side auth (runs already carry `principal` from input; wiring the console's principal into run *starts* arrives with the first console-triggered run in Phase 2).

## Acceptance criteria
- [ ] Property/unit tests: scrypt verify accepts the right password and rejects others; session tokens round-trip, expire at ttl, and any single-character tamper is rejected as `tampered` — all pure with injected clock.
- [ ] `can` is exhaustively tested over all five roles; viewer can `view_runs` but not `manage_platform`; unknown actions default to deny.
- [ ] Accounts file parsing: valid file loads; malformed entries produce typed zod errors; no credential material is ever committed (dev seed is clearly marked and password-hash only).
- [ ] Console: unauthenticated requests to `/runs*` redirect to `/login`; after sign-in the pages render with the principal shown; sign-out clears the session. Verified against the running app.
- [ ] `pnpm test` and `pnpm build` (including console `next build`) green.
