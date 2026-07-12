# 036 — Tenant registry + schema-per-tenant storage

**Packages:** `packages/storage` (schema scoping) + `apps/worker` (tenant config) · **Depends on:** 006, 035 · **Allowed deps:** none new

## Context
Build-plan Phase 4(b), the baseline that unblocks the rest of the enterprise wrap: tenants as first-class configuration, isolated at the STORAGE layer — one Postgres, one schema per tenant, no shared tables. Isolation is proven, not asserted: the conformance suite runs per schema, and a dedicated test shows tenant A's store cannot see tenant B's runs even when runIds collide. Per-tenant data keys ride on 035's codec — each tenant's logs are readable only with that tenant's key.

## Scope
1. `TenantsConfig` (`deploy/tenants.config.json`, zod, `.strict()`): `{ tenants: [{ id: /^[a-z][a-z0-9-]{1,30}$/, displayName, dataKeyEnv? }] }` — ids become schema names (`tenant_<id>` with `-`→`_`), duplicates refuse, and `dataKeyEnv` names the env var holding that tenant's 035 key (never the key itself).
2. Schema-scoped storage: `migrate(pool, { schema })` creates the schema if absent and applies the same forward-only migrations inside it (table names schema-qualified); `PostgresEventStore`/`PostgresScoreStore`/`PostgresHoldStore` take an optional `schema` and qualify every statement — `public` behavior byte-identical when unset (all existing deployments unaffected).
3. `openTenantStores(pool, config, env)` in `apps/worker/src/tenants.ts`: per tenant — migrate its schema, build its `EventStore` (wrapped in that tenant's encrypting codec when `dataKeyEnv` is set and populated; a NAMED-but-empty key env is a boot failure, never silent plaintext), return `Map<tenantId, TenantStores>`.
4. Isolation, proven: same runId appended in two tenants' stores → each loads only its own events; `listRuns` never crosses; `deleteRun` in one leaves the other; the 002 conformance suite passes against a non-`public` schema (CI, real Postgres).
5. `run-all`-grade unit coverage for config parsing (bad slug, duplicate id, empty-but-named key env) — boot failures, never runtime surprises.

## Out of scope
Engine/queue scoping (037), console tenancy (038), tenant CRUD APIs (config file is the registry), cross-tenant reporting, database-per-tenant profile.

## Acceptance criteria
- [ ] Tenant ids validate as slugs; duplicates and empty-but-named key envs fail boot loudly.
- [ ] The same migrations apply per schema; `public` unset-schema behavior is byte-identical (existing tests untouched and green).
- [ ] Conformance passes against a non-`public` schema in CI; the runId-collision isolation test proves no cross-tenant reads or deletes.
- [ ] Per-tenant 035 keys: tenant A's key cannot read tenant B's rows (typed failure).
- [ ] `pnpm test` and `pnpm build` green.
