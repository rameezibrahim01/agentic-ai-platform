# 003 — Temporal workflow skeleton + the kill test

**Package:** `apps/worker` · **Depends on:** 001, 002 · **Allowed deps (add in this ticket):** `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity`, `@temporalio/client`, `@temporalio/testing` (dev)

## Context
Build-plan Phase 1, workstream (a): the agent loop as a durable workflow. This ticket earns exit drill #1 — the kill test. In-memory loops are disqualified by design (architecture §4).

## Scope
1. `agentRun` workflow: loop of `think → act` using **stub** activities (`callModel`, `executeTool`) that return scripted values — no real providers yet.
2. Each activity appends its event through the `EventStore` (in-memory for tests) using an **idempotency key** = `(runId, seq)`: a retried activity must not double-append (CLAUDE.md #3).
3. Workflow code is deterministic: no `Date.now`, no `Math.random` — Temporal workflow time and side-effect APIs only. `at` timestamps are produced in activities, not workflow code.
4. Terminate on scripted `RunCompleted` or on `maxSteps` guard (hard-coded 10 until ticket 005).
5. Worker bootstrap (`src/worker.ts`) + a client helper to start a run.

## Out of scope
Real model/tool calls, budgets beyond the hard guard, approvals, Temporal Cloud config.

## Acceptance criteria
- [ ] **Kill test** using `@temporalio/testing` `TestWorkflowEnvironment`: start a run, stop the worker between two activities, start a fresh worker — the run completes; the event log shows **zero** duplicated events (idempotency proven, not assumed).
- [ ] Retry test: an activity that fails once then succeeds yields exactly one appended event.
- [ ] Determinism: replaying the workflow (test env) produces no non-determinism errors.
- [ ] `pnpm test` green locally without any external Temporal server (test env only); flip `WORKER_READY`.
