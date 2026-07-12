# 044 — Retention parity for run_scores: no orphaned observations

**Packages:** `packages/storage` (score deletion) + `apps/worker` (retention CLI) · **Depends on:** 029, 032, 036 · **Allowed deps:** none new

## Context
032's retention deletes whole terminal runs from the event log; 029's `run_scores` sits deliberately OUTSIDE that log — which means today a deleted run leaves its score behind: an orphaned observation about data the policy said must go. Retention must treat the score as part of the run's data footprint: deleted together, held together. Tenancy (036) adds the second gap — the retention CLI only speaks to the untenanted store.

## Scope
1. `ScoreStore.delete(runId)` on both implementations (`InMemoryScoreStore`, `PostgresScoreStore`): idempotent, typed `{ok} | {ok:false, error:"not_found"}` — the ONLY deletion path for scores, mirroring `deleteRun`.
2. `applyRetention` gains an optional `scores?: ScoreStore`: every run it deletes also deletes that run's score (after the event-log delete succeeds; a missing score is not an error); held and skipped runs' scores are untouched; `dryRun` reports would-be score deletions in the report (`deletedScores`).
3. Retention CLI: `--tenant <id>` resolves that tenant's schema-scoped event/score/hold stores from `TENANTS_CONFIG` (036's `openTenantStores` machinery); untenanted default byte-identical to today's behavior plus score parity.
4. Tests: deleted run → score gone; held run → score survives every pass; run without a score deletes cleanly; dry-run reports without deleting; per-tenant isolation (retention in acme's schema never touches globex's scores — CI, real Postgres); idempotent double-delete.
5. `docs/architecture.md` touch only if it describes retention's scope (keep the docs truthful about scores being covered).

## Out of scope
Score-specific retention policies (scores live and die with their run), retention for legal_holds rows themselves (the hold history IS the audit record — 032's design), audit-export of scores.

## Acceptance criteria
- [ ] A retained (deleted) run's score is deleted in the same pass; a held run's score survives; dry-run reports both without writing.
- [ ] `ScoreStore.delete` is the only score-deletion path, idempotent and typed, on both stores (Postgres in CI).
- [ ] Retention CLI works per-tenant via `TENANTS_CONFIG`; untenanted behavior unchanged apart from score parity.
- [ ] Cross-tenant isolation of retention passes is test-pinned.
- [ ] `pnpm test` and `pnpm build` green.
