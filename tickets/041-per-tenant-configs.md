# 041 — Per-tenant model & tool configs: the next isolation cut

**Packages:** `apps/worker` · **Depends on:** 021, 026, 037 · **Allowed deps:** none new

## Context
037 gave every tenant its own store, key, queue, and limits — but the model and tool gateways stayed shared platform capability. Real tenants differ exactly there: which tools are enabled, who is granted them, what egress is allowed, which models are callable at what pricing. The 037 limits pattern already solved config-per-lane (`limits.<id>.config.json` beside the shared file, loud on invalid, fallback on absent); this ticket applies the same rule to `TOOLS_CONFIG` and `MODELS_CONFIG`, so a tenant's gateway is BUILT from that tenant's config — a tool granted to acme does not exist in globex's lane.

## Scope
1. Per-lane resolution in the tenant worker bootstrap: `tools.<id>.config.json` / `models.<id>.config.json` beside the shared `TOOLS_CONFIG`/`MODELS_CONFIG` files — present → that tenant's gateway is built from it (same zod validation, same catalog); absent → the shared gateway is reused; INVALID → boot failure for the whole process, never a silent fallback to shared grants.
2. Gateways become per-lane: `createActivities` for tenant X receives X's tool gateway and X's model gateway; the shared instances are built once and shared only by lanes without overrides (no behavior change for them). Boot logs name each lane's config source.
3. Untenanted worker byte-identical: no `TENANTS_CONFIG` → exactly today's single shared gateway path.
4. Tests: resolution matrix (absent→shared, present→own, invalid→boot failure) unit-tested against real temp files; isolation pinned — a tool enabled+granted only in acme's config is refused-and-audited (`unknown_tool`/`not_granted`) when the same intent runs in globex's lane, and acme's lane executes it (Temporal or direct-activities level, whichever the existing suites use for gateway refusals); a model allowlisted only for acme is a typed gateway refusal in globex's lane.
5. `deploy/`: document the per-tenant file convention where `tools.config.json` is mounted (compose comment + `.env.example` note); no new mounts needed — overrides live beside the shared files in the same mounted directory.

## Out of scope
Per-tenant ANTHROPIC_API_KEYs (provider credentials stay deployment-level env; per-tenant BYO-keys need a secrets-mount design — new issue when scoped), per-tenant MCP server processes, per-tenant agents/evals configs, console editing of tenant configs.

## Acceptance criteria
- [ ] `tools.<id>.config.json` / `models.<id>.config.json` beside the shared files govern that lane; absent falls back to shared; invalid refuses boot loudly.
- [ ] A tool granted only in tenant A's config executes in A's lane and is refused-and-audited in B's; a model allowlisted only for A is a typed refusal in B (test-pinned).
- [ ] Untenanted worker path byte-identical (existing suites untouched and green).
- [ ] `pnpm test` and `pnpm build` green.
