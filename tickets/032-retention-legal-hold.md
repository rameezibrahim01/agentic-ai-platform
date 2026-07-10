# 032 — Retention policies + legal hold on run logs

**Packages:** `packages/storage` (retention ops) + `apps/worker` (CLI glue) · **Depends on:** 006, 031 · **Allowed deps:** none new

## Context
Build-plan Phase 4(f). The event log is append-only *within* a run's lifetime (CLAUDE.md #5); retention is the deliberate, audited END of that lifetime — whole terminal runs deleted by an explicit policy, never edited. Legal hold inverts the priority: a held run survives every policy until the hold is lifted, and both placing and lifting a hold are recorded facts.

## Scope
1. `RetentionPolicy` in `packages/storage`: `{ maxAgeMs }` applied only to TERMINAL runs (completed/failed) — a running or awaiting-approval run is never eligible regardless of age.
2. Legal hold store (in-memory + Postgres `legal_holds` table, migration 003): `place(runId, by, reason, at)`, `lift(runId, by, at)`, `isHeld(runId)`, `list()` — holds are facts with actor + reason + time; placing twice refuses, lifting keeps the history row (lifted_at set, never deleted).
3. `applyRetention(store, holds, policy, nowMs)` → `{ deleted: runId[], skippedHeld: runId[], skippedActive: runId[] }`: deletes whole runs only (all events of a run in one transaction — never partial logs), skips held and non-terminal runs, and returns a full report. Deletion exists ONLY here; the EventStore contract gains `deleteRun(runId)` with both adapters + conformance coverage.
4. Recommended flow documented in the CLI: export (031) before retention — `apps/worker/src/retention-cli.ts <maxAgeDays> [--dry-run]` prints the would-delete report; the real run requires `--yes`.
5. Tests: eligibility matrix (age × status × hold) property-tested; partial deletion impossible (a failed delete leaves the full log); Postgres half CI-authoritative; hold history round-trips.

## Out of scope
Per-tenant policies (no tenants), automatic scheduling of retention (an ops decision — the CLI is the mechanism), export coupling enforcement (documented, not forced), score/`run_scores` retention (follow-up seed).

## Acceptance criteria
- [ ] Only terminal, unheld, over-age runs are deleted — whole runs, atomically; the eligibility matrix is property-tested.
- [ ] Legal hold beats every policy; placing/lifting are recorded with actor, reason, time; history survives lifting.
- [ ] `deleteRun` covered by the storage conformance suite in both adapters (Postgres in CI).
- [ ] Dry-run reports without deleting; the real run requires an explicit `--yes`.
- [ ] `pnpm test` and `pnpm build` green.
