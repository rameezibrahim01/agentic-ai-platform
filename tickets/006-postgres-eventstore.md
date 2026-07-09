# 006 — Postgres EventStore adapter

**Package:** `packages/storage` · **Depends on:** 002 · **Allowed deps (add in this ticket):** `pg` (+ `@types/pg` dev)

## Context
Runs must survive real crashes on real infrastructure (architecture §4; system of record is Postgres, §2). Ticket 002 defined the `EventStore` contract and a conformance suite precisely so this adapter could arrive without changing a single consumer — it runs the identical tests.

## Scope
1. `PostgresEventStore` implementing 002's `EventStore` against `pg.Pool`:
   - `append` is **one transaction** with optimistic concurrency — version check and insert atomically; a unique index on `(run_id, seq)` is the last line of defense; serialization/unique-violation conflicts surface as `{ ok: false, conflict: { actualVersion } }`, never as throws.
   - Events stored as JSONB, validated with core's `parseEvent` on load (a corrupted row is a typed failure, not a crash).
2. **Forward-only SQL migrations**: numbered `.sql` files in `packages/storage/migrations/`, applied by a `migrate(pool)` helper that records applied migrations in a `schema_migrations` table. No down migrations (CLAUDE.md-adjacent: release artifacts ship forward-only migrations, architecture §10).
3. Connection config via env (`TEST_DATABASE_URL` in tests); helper `createPostgresEventStore(connectionString)`.
4. `InMemoryEventStore` remains the default everywhere; Postgres tests run where a database is reachable — **CI provides a Postgres service container and is the authoritative run**; locally the suite skips loudly when `TEST_DATABASE_URL` is unset (and never skips in CI).

## Out of scope
Snapshots, subscriptions/streaming, retention, connection pooling tuning, schema-per-tenant.

## Acceptance criteria
- [ ] Ticket 002's conformance suite (`describeEventStoreContract`) runs **unchanged** against `PostgresEventStore` and is green in CI.
- [ ] Concurrency proven on real Postgres: the conformance racer/retry property tests pass against the transactional append.
- [ ] `migrate` is idempotent: applying twice changes nothing; migrations apply in numeric order.
- [ ] CI job includes a Postgres service and runs the adapter tests (no skips in CI); local runs without `TEST_DATABASE_URL` skip with a loud warning.
- [ ] `pnpm test` and `pnpm build` green across the workspace.
