# 066 — Run list at pilot scale

**Packages:** `packages/storage`, `apps/console` · **Depends on:** 006, 009 · **Allowed deps:** none new

## Context
The runs page was built for a demo: `listRuns()` returns every run in the store, and
`runListView` then RE-loads and RE-replays each one for numbers the summaries already carry.
A two-week pilot produces thousands of runs; the first page of the console must not cost
O(all runs ever). This ticket makes the list a real query: filtered, ordered, paginated at
the store, and rendered straight from summaries — behavior-identical for everything else.

## Scope
1. `packages/storage`: `RunFilter` gains optional `limit` and `offset` (additive). Ordering
   becomes part of the CONTRACT: newest-first by the run's `startedAt` (first event's `at`),
   runId as the deterministic tiebreak — with or without pagination. The conformance suite is
   the spec: update it once, and both stores obey it.
2. `PostgresEventStore.listRuns` pushes filter/order/pagination into SQL (order by the seq-0
   event's `at`, then run_id; limit/offset) instead of materializing every run; the in-memory
   store sorts and slices the same way. Encrypted stores keep their honesty rule: an
   undecryptable run is absent, never garbage — pagination counts what it can read.
3. `apps/console`: `runListView(store, { status?, page })` passes the filter down and renders
   from `RunSummary` alone — the per-run `load()`+`replay()` loop is deleted. `/runs` gains
   status filter links (all / running / awaiting_approval / completed / failed) and
   prev/next paging (fixed page size, e.g. 50), both as plain `?status=&page=` links —
   server-rendered, no client state.
4. The approvals inbox keeps its own view (it needs pending-intent detail from the log);
   only the run LIST changes.
5. Tests: conformance ordering/pagination cases (both stores via the shared suite, incl.
   filter+pagination combined and the offset-past-end edge), viewmodel paging, page render
   with filters. A seed script is NOT needed — conformance generators cover volume.

## Out of scope
Cursor pagination (offset is honest at pilot scale), free-text search, sorting options,
date-range filters, run archival (032 owns retention), counts-per-status badges.

## Acceptance criteria
- [ ] Both stores return newest-first, deterministically tiebroken, correctly filtered and
      paginated pages (conformance-tested).
- [ ] The Postgres store answers a page without loading or replaying non-page runs.
- [ ] `/runs` shows pages with working status filters and prev/next; numbers match the
      summaries exactly as before.
- [ ] `pnpm test` and `pnpm build` green.
