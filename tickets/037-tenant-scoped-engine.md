# 037 — Tenant-scoped engine: one worker process, isolated lanes

**Packages:** `apps/worker` · **Depends on:** 036, 033 · **Allowed deps:** none new

## Context
With storage isolated (036), the engine follows: each tenant gets its own Temporal task queue and its own activity set bound to its own store, key, grants, and limits — one worker process hosts them all, but nothing is shared between lanes. A run physically cannot land in another tenant's store because the activities that write it were constructed with only one store in hand.

## Scope
1. `taskQueueFor(tenantId)` = `agent-runs--<tenantId>` (the untenanted queue name stays `agent-runs`, byte-identical for existing deployments).
2. Worker bootstrap: `TENANTS_CONFIG` set → for each tenant, `openTenantStores` (036) + a per-tenant `createActivities` (tenant store, tenant limits file via `limits.<id>.config.json` beside the shared one when present, shared tool/model gateways) + one `Worker.create` on that tenant's queue; all workers run concurrently under one process with a clean joint shutdown. No `TENANTS_CONFIG` → exactly today's single worker.
3. `startAgentRun` gains an optional `tenant` option resolving the task queue; `demo-run.ts` gains `--tenant <id>`; schedules/templates pass through unchanged (they already accept a `taskQueue`).
4. Per-tenant kill switches: the 033 `checkLimits` activity is already per-activity-set — each tenant's lane reads its own limits file when present, falling back to the shared `LIMITS_CONFIG`; flipping one tenant's switch stops that tenant only (test-pinned).
5. Tests (Temporal, CI-authoritative): two tenants, two queues, one worker process — a run started on tenant A's queue lands ONLY in A's store (B's store byte-identical before/after); the same runId started on both queues yields two independent runs; A's tripped kill switch stops A's run while B's completes.

## Out of scope
Console tenancy (038), per-tenant model gateways/tool configs (shared platform capabilities in this slice — the deployment decides), tenant-level Temporal namespaces (queues are the isolation unit at this scale), autoscaling.

## Acceptance criteria
- [ ] No `TENANTS_CONFIG` → single-worker behavior byte-identical (existing Temporal suites untouched and green).
- [ ] Two-tenant Temporal test: runs land only in their own store; colliding runIds coexist; the log proves it.
- [ ] Per-tenant kill switch stops one lane and not the other (Temporal test).
- [ ] `demo-run --tenant` targets the right queue; `startAgentRun` tenant option covered by tests.
- [ ] `pnpm test` and `pnpm build` green.
