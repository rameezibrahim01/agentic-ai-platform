# 042 — Platform-operator view: cross-tenant health without cross-tenant browsing

**Packages:** `apps/console` · **Depends on:** 038 · **Allowed deps:** none new

## Context
038 deliberately left a hole it flagged as a real need: whoever OPERATES a tenanted deployment needs to see all lanes at once — run volumes, failure rates, kill-switch states — without per-tenant sessions becoming the workaround (or worse, a shared "super-tenant"). The honest shape: an explicit operator surface that shows per-tenant METADATA (counts, statuses, costs, switch states) and deliberately cannot browse into another tenant's run contents — the pages that render events stay session-tenant-scoped exactly as 038 built them.

## Scope
1. `operatorOverview(tenants: Map<id, {store, displayName}>, limitsFor)` (pure, `lib/`): per tenant — run counts by status, total/awaiting-approval counts, summed cost, kill-switch state (global + per-agent trips from that lane's 037 limits resolution); tenants whose stores are unreadable (key not mounted console-side) report `runs: "unreadable"` honestly rather than 0.
2. `/tenants` page: rendered ONLY when (a) the deployment is tenanted, (b) the session has `platform_admin`, and (c) the session is NOT tenant-bound (an operator identity, not a tenant identity — a tenant-bound admin manages their tenant, not the platform). Everyone else: 403-style plain explanation. No links into `/runs/<id>` for other tenants — the overview is the boundary.
3. Store plumbing: `getAllTenantStores()` in `lib/store.ts` reusing the existing per-tenant cache; construction only — no new query surface.
4. Header: operator sessions (untenanted admin in tenanted mode) get a `tenants` nav link; 038's "you are not bound to a tenant" explanation on `/runs` points operators at `/tenants`.
5. Tests: gating matrix (viewer refused, tenant-bound platform_admin refused, untenanted-deployment page says so, operator admitted); overview math over two seeded stores incl. the unreadable-store row; no-browsing guarantee = `/runs`-family pages still resolve ONLY via session tenant (existing 038 tests remain the pin, plus one test that an operator session sees nothing on `/runs`).

## Out of scope
Cross-tenant run/event browsing (would break the key boundary — per-tenant keys mean the console may not even be able to decrypt), operator WRITE actions (kill-switch flipping stays a config edit until the 033 write-path auth design), tenant CRUD, usage-based billing rollups.

## Acceptance criteria
- [ ] `/tenants` renders per-tenant counts/status/cost/kill-switch rows for an operator session; unreadable tenants are reported honestly.
- [ ] Gating: only untenanted `platform_admin` sessions in a tenanted deployment; all other combinations get typed/plain refusals (test-pinned).
- [ ] No cross-tenant content path exists: run pages still resolve exclusively via the session tenant (038 tests untouched, plus the operator-sees-no-runs pin).
- [ ] `pnpm test`, `pnpm build`, console Next build green.
