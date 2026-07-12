# 038 — Tenant-aware console: sessions bind to a tenant, views never cross

**Packages:** `packages/auth` (tenant claim) + `apps/console` · **Depends on:** 036, 034 · **Allowed deps:** none new

## Context
Storage and engine lanes are isolated (036/037); the console must not become the place they leak back together. A session BINDS to exactly one tenant at sign-in — from the account record or the IdP claim map — and every page and API resolves its store through that binding. "Developer in workspace A" seeing workspace B's runs must be impossible by construction, not by remembering to filter.

## Scope
1. `SessionClaims` gains optional `tenant` (absent = the untenanted single-tenant deployment, byte-identical today): local accounts may carry `tenant`; the OIDC config gains `tenantClaim?` + `tenantMap?` (IdP value → tenant id) with unmapped-but-required → refused login, never a default tenant.
2. Console store selection becomes per-tenant: with `TENANTS_CONFIG` mounted, `getStore(tenant)` opens that tenant's schema (and key via `dataKeyEnv`); pages/APIs pass the SESSION's tenant — there is no query-param or header override. Sessions without a tenant in a tenanted deployment see nothing and get a plain explanation.
3. Approvals stay honest: the approval POST signals through the tenant's task queue-scoped workflow (workflowId = runId within the tenant's lane); a session bound to tenant A cannot signal a run it cannot see (the store lookup gates it).
4. `/runs`, `/runs/[id]`, `/approvals`, `/costs`, `/limits` all resolve through the session tenant; the header shows which tenant the session is scoped to.
5. Tests: session round-trip with tenant; OIDC tenant mapping (mapped / unmapped-refused); store selection unit tests (A's session lists only A's runs — two seeded schemas via injected stores); approval gating (A's session, B's runId → 404, no signal sent).

## Out of scope
Multi-tenant sessions / tenant switching UI, per-tenant account files (one accounts file, tenant per account), tenant admin UI, cross-tenant platform-operator views (a real need — new issue when scoped).

## Acceptance criteria
- [ ] Untenanted deployments byte-identical (no `TENANTS_CONFIG` → today's behavior; existing console tests untouched).
- [ ] A session carries at most one tenant, set only at sign-in from account/IdP mapping; unmapped-in-tenanted-mode is a refused login.
- [ ] Every console surface resolves the store from the session tenant; A can never list, view, or approve B's runs (test-pinned, including the no-signal assertion).
- [ ] `pnpm test`, `pnpm build`, and the console Next build green.
