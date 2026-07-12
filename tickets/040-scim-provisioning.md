# 040 — SCIM provisioning floor: the IdP owns the user lifecycle

**Packages:** `packages/auth` (SCIM mapping, pure) + `packages/storage` (account store) + `apps/console` (endpoints + login wiring) · **Depends on:** 034, 036, 038 · **Allowed deps:** none new

## Context
The onboarding drill's automated half (039) stops where user lifecycle begins: today accounts are a mounted file and OIDC roles/tenants come from claim maps at login — nothing DEprovisions. SCIM 2.0 is the protocol every enterprise IdP (Okta, Entra, Keycloak) speaks for exactly this. The floor worth shipping: a bearer-token-authenticated `/api/scim/v2/Users` subset backed by a Postgres account store, where the account record is AUTHORITATIVE at login — an IdP that deactivates a user has revoked their console access even while their id tokens are still technically valid. That is the deprovisioning story auditors ask for.

## Scope
1. Account store (`packages/storage`): migration `004-accounts.sql` — `accounts(username pk, external_id, roles jsonb, tenant, active boolean, updated_at)`; `PostgresAccountStore` + `InMemoryAccountStore` behind one `AccountStore` interface (`upsert`, `get`, `getByExternalId`, `list`, `deactivate`), schema-qualified like the other stores (per-deployment table; the TENANT is a column — accounts are not tenant-schema data).
2. SCIM mapping (`packages/auth`, pure): zod schemas for the SCIM User resource subset (userName, externalId, active, `groups[].value`); `scimToAccount(user, roleMapping, tenantMapping?)` reuses the SAME 034/038 maps — IdP groups grant roles/tenant only if the config says so; unmapped-tenant-in-tenanted-mode is a typed refusal at provision time, mirroring login.
3. Console endpoints: `POST /api/scim/v2/Users` (create/reactivate by externalId), `GET /api/scim/v2/Users` (+ `filter=userName eq "..."`), `GET/PATCH/DELETE /api/scim/v2/Users/[id]` (PATCH `active`, DELETE = deactivate — never a row deletion; the audit trail keeps the who). Auth: `SCIM_TOKEN_ENV` names the env var holding the bearer token (constant-time compare); missing config = endpoints 404 (feature off), missing/wrong token = 401. SCIM content type + error shapes per RFC 7644's minimum.
4. Login becomes store-aware: when the account store is configured, OIDC callback resolves the account by externalId/sub — missing or `active=false` → refused login (401), roles+tenant come from the RECORD (provisioned truth), not the claim maps; without a store, claim-map behavior stays byte-identical. Local (password) accounts stay file-based and unaffected.
5. Tests: token matrix (off/missing/wrong/right); create→get→deactivate round-trip incl. reactivation by externalId; deactivated federated user with a VALID id token is refused (the deprovisioning claim, test-pinned); record-over-claims precedence; store conformance InMemory vs Postgres (CI); untenanted + storeless deployments byte-identical.

## Out of scope
SCIM Groups resource (roles ride Users.groups values), SCIM for local/password accounts, bulk operations, ETags/pagination beyond `startIndex/count`, tenant CRUD via SCIM (the tenants file stays the registry), SCIM against a real IdP (human-owned half of drill p4-4).

## Acceptance criteria
- [ ] SCIM Users subset works end-to-end against the store: create, filter/get, deactivate, reactivate — all bearer-authenticated, typed 401/400/404 refusals.
- [ ] Deactivating a user refuses their next OIDC login even with a valid id token; reactivation restores it (test-pinned).
- [ ] Provisioned roles/tenant come from the account record at login; claim-map fallback (no store configured) is byte-identical to 038.
- [ ] Account store conformance runs on Postgres in CI; migration is forward-only alongside 001–003.
- [ ] `pnpm test`, `pnpm build`, console Next build green.
