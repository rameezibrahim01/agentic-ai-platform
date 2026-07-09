# 002 — Event-log storage contract + in-memory adapter

**Package:** `packages/storage` · **Depends on:** 001 · **Allowed deps:** `@platform/core` only

## Context
Runs must survive crashes; concurrent writers must not corrupt a log (architecture §4). The contract is defined here and proven against an in-memory reference implementation; Postgres arrives in a later ticket against the *same* test suite.

## Scope
1. `EventStore` interface:
   - `append(runId, expectedVersion, events[]): AppendResult` — optimistic concurrency: succeeds iff `expectedVersion` equals current log length; result is `{ ok: true, version }` or `{ ok: false, conflict: { actualVersion } }`.
   - `load(runId): { events, version } | null`
   - `listRuns(filter?): RunSummary[]` (status, steps, cost — derived via core's `replay`).
2. `InMemoryEventStore` implementing it; appends are atomic per run.
3. A **reusable conformance suite**: `describeEventStoreContract(makeStore)` exported so future adapters (Postgres) run the identical tests.

## Out of scope
Postgres, snapshots, subscriptions/streaming, retention.

## Acceptance criteria
- [ ] Property test: N interleaved writers appending with stale versions — exactly the expected appends win; final log has contiguous `seq`; `replay` never sees a torn write.
- [ ] Conflict result carries `actualVersion`; a retry with the corrected version succeeds.
- [ ] `load` after arbitrary append history replays to the same state that incremental reduction produced (uses 001's replay ≡ incremental property).
- [ ] Conformance suite runs green against `InMemoryEventStore` and is import-ready for the future Postgres adapter.
- [ ] Flip `STORAGE_READY`; `pnpm test` and `pnpm build` green.
