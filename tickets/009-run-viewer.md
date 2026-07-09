# 009 — Run viewer console

**Package:** new `apps/console` · **Depends on:** 001, 002 · **Allowed deps (add in this ticket):** `next`, `react`, `react-dom` (+ `@types/react`, `@types/react-dom` dev)

## Context
Build-plan Phase 1 workstream (c): "a deliberately boring console page — a table of runs and a step timeline with tokens and cost per step. Resist making this beautiful; make it truthful." Read-only, served against the `EventStore`. This page is the audit test's UI (exit drill 4).

## Scope
1. **View models first** (`src/lib/viewmodels.ts`, pure, fully unit-tested — the truthfulness lives here):
   - `runListView(store)` → rows `{ runId, status, steps, tokensIn, tokensOut, costUsd, startedAt }` derived via core's `replay`;
   - `runTimelineView(store, runId)` → ordered step rows straight from the event log: seq, type, human summary, per-event tokens/cost where applicable, running cost total — and the run's terminal outcome. Unknown run → typed `null`, corrupt log → typed error surfaced, never a crash.
2. Next.js app (App Router, server components only, zero client JS beyond Next defaults):
   - `/runs` — the table; `/runs/[runId]` — the step timeline;
   - store selection via env: `DATABASE_URL` set → Postgres adapter (006), else in-memory store seeded with a demo run so the pages render something truthful out of the box;
   - all times rendered as ISO-8601 UTC (CLAUDE.md #1).
3. `pnpm build` keeps working workspace-wide; the console builds via its own `next build` script (wired into CI).

## Out of scope
Auth (Phase 1 workstream (e) handles sign-in separately), live updates/polling, writes of any kind, styling beyond minimal readable tables, pagination.

## Acceptance criteria
- [ ] View-model unit tests: list and timeline derived from scripted event logs match the reducer's state exactly (statuses, steps, token/cost totals, running totals per row); unknown run and corrupt log are typed results.
- [ ] Timeline shows every event in seq order with tokens and cost per model step and a correct running total — verified against a run that includes failover-priced steps and a budget-terminated run.
- [ ] Console pages are server-rendered, read-only (no mutating routes), and display timestamps in UTC.
- [ ] `next build` for `apps/console` runs in CI and passes; `pnpm test` and `pnpm build` green across the workspace.
