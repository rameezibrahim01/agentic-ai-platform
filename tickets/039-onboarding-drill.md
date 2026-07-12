# 039 — The onboarding drill, reference form: a second tenant from config alone

**Packages:** `deploy/`, `scripts/drills/`, `docs/drills/` · **Depends on:** 036, 037, 038 · **Allowed deps:** none new

## Context
Build-plan Phase 4 exit drill 1 ("a second tenant goes from contract to first governed run with zero vendor-side manual steps") needs SSO/SCIM against a real IdP and a real second customer — human-owned. What is machine-checkable TODAY is its reference form: adding a tenant is EDITING ONE CONFIG FILE — no code, no rebuild — and the new tenant's first governed run executes fully isolated from the existing tenant. That is the claim enterprise buyers actually probe, and this drill makes it a script that exits 0 in CI.

## Scope
1. Compose ships tenanted: `deploy/tenants.config.json` with tenant `acme` (own data-key env), mounted into worker and console; `.env.example` documents the per-tenant key vars. The untenanted artifact path remains available (drills 7/p2-1/p4-2 keep their current single-tenant boots by overriding `TENANTS_CONFIG=`), so every existing drill is untouched.
2. `scripts/drills/drill-p4-3-onboarding.sh` (CI, compose):
   a. Boot with tenant `acme` only → demo write runs on acme's lane → acme's schema has the run, ciphertext under acme's key.
   b. **Onboard `globex` by editing the mounted config** (append the tenant + its key env) and restarting worker+console — the only "vendor step" is config, which is the point.
   c. globex's first governed write executes on its own queue into its own schema under its own key.
   d. Isolation asserted three ways: schemas hold only their own runs (psql), acme's console session lists no globex runs and 404s on globex's runId, and acme's key cannot read globex's rows (raw-row grep + typed console absence).
3. `docs/drills/phase-4.md`: drill 3 recorded in reference form with the human-owned half (real IdP + SCIM + real customer) explicitly OPEN; the drill map and `run-all.sh` updated.
4. `tickets/BACKLOG.md` refreshed: SCIM provisioning, tenant admin/operator views, per-tenant model/tool configs seeded as the next expansion.

## Out of scope
SCIM, real-IdP flows, tenant self-service signup, billing, the actual second customer (human-owned, recorded).

## Acceptance criteria
- [ ] Onboarding a tenant = one config edit + restart; the drill performs it verbatim and the new tenant's first governed run completes.
- [ ] Isolation asserted at storage (schemas), engine (queues/stores), console (session scoping), and key (cross-key unreadability) levels — all in the drill.
- [ ] Every pre-existing drill still passes unmodified (single-tenant boots preserved).
- [ ] `docs/drills/phase-4.md` + `run-all.sh` + backlog updated; CI drills green.
- [ ] `pnpm test` and `pnpm build` green.
