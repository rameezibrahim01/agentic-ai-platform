# 010 — Thin schedules

**Package:** `apps/worker` · **Depends on:** 003, 005 · **Allowed deps:** none new (`@temporalio/client` Schedules API, already present)

## Context
Build-plan Phase 1 workstream (e) and exit drill 6: "check X every morning" — recurring runs for read-only agents via Temporal Schedules, with the operational policies that separate toys from platforms chosen **explicitly**: timezone pinning, skip-if-running overlap, and a deliberate catch-up decision (architecture §3).

## Scope
1. `src/schedules.ts`: `createAgentSchedule(client, spec)` where spec is
   `{ scheduleId, cron, timezone, template: AgentRunInput (a run template: agent + bound parameters), overlap?: "skip" (default), catchupWindowMs?, paused? }`:
   - timezone-pinned calendar spec (the cron evaluates in the named zone, never server-local — CLAUDE.md #1 governs storage, display, and this exception is explicit);
   - overlap policy defaults to `SKIP` (skip the occurrence while the prior run is still going);
   - catch-up window is an **explicit required decision** when creating: pass `catchupWindowMs: 0` (drop missed occurrences) or a positive window (run them) — no accidental default;
   - each occurrence starts `agentRun` with a deterministic per-occurrence `runId` = `${scheduleId}-${occurrence ISO time}` so retried scheduler actions dedupe (workflowId = runId from 003).
2. Helpers: `describeAgentSchedule`, `pauseAgentSchedule`/`resumeAgentSchedule`, `deleteAgentSchedule` — thin, typed wrappers.
3. Tests against the ephemeral Temporal server (same CI-authoritative skip pattern as 003/005):
   - schedule created with the right policies (verified via describe: timezone, overlap SKIP, catch-up window);
   - an immediately-triggered occurrence starts a real `agentRun` that completes and lands in the event store;
   - triggering while a run is in flight with overlap SKIP does not start a second concurrent run for the same schedule;
   - pause/resume reflected in describe output.

## Out of scope
Event triggers/webhooks (Phase 2), run templates as persisted control-plane objects (Phase 2), standing delegation grants (Phase 2), schedule UI.

## Acceptance criteria
- [ ] Create/describe test: schedule carries pinned timezone, `SKIP` overlap, and the explicitly chosen catch-up window; creating without a catch-up decision is a compile-time error.
- [ ] Trigger test: a triggered occurrence executes `agentRun` end-to-end (event log completes) with the deterministic occurrence `runId`.
- [ ] Overlap test: with a long-running occurrence in flight, a second trigger under `SKIP` does not produce a second running workflow.
- [ ] Pause/resume round-trips through describe.
- [ ] CI runs the schedule tests for real (ephemeral server; no skips in CI); `pnpm test` and `pnpm build` green.
