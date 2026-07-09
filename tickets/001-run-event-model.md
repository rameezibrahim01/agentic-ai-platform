# 001 — Run event model + reducer

**Package:** `packages/core` · **Depends on:** nothing · **Allowed deps:** `zod` (already present)

## Context
The run is the platform's atom: an append-only event log plus a deterministic reducer (`docs/architecture.md` §4). Everything later — Temporal workflows, storage, audit, replay — consumes this model. Get it right first.

## Scope
1. Event types (discriminated union on `type`, zod schema for each, all times epoch-ms UTC):
   `RunStarted, ModelCalled, ToolIntentEmitted, PolicyEvaluated, ApprovalRequested, ApprovalGranted, ApprovalDenied, ToolExecuted, ToolFailed, BudgetExceeded, RunCompleted, RunFailed`.
   Every event carries `{ runId, seq, at }`; payloads follow the log sketch in architecture §4.
2. `RunState`: status (`running | awaiting_approval | completed | failed`), step count, token/cost totals, pending intent/approval, terminal outcome.
3. `reduce(state, event): ReduceResult` and `replay(events): ReplayResult` — pure, no clock, no I/O, no randomness.
4. Illegal transitions (e.g. `ToolExecuted` while `awaiting_approval`, any event after terminal, non-contiguous `seq`) return a typed rejection — never throw across the boundary, never mutate input state.
5. Export `parseEvent(unknown)` for boundary validation.

## Out of scope
Storage, Temporal, budgets *enforcement* (005 — but include the `BudgetExceeded` event type now), any I/O.

## Acceptance criteria
- [ ] Property test (fast-check): for arbitrary **valid** event sequences, `replay` is deterministic and order-dependent — same events, same state, every time.
- [ ] Property test: replaying `events` equals folding `reduce` incrementally (replay ≡ incremental).
- [ ] Property test: arbitrary invalid interleavings are rejected with a typed reason; state before rejection is unchanged (purity).
- [ ] Exhaustive `switch` on event type — compiler error if a variant is unhandled (`satisfies never`).
- [ ] `parseEvent` rejects malformed payloads with zod issues surfaced.
- [ ] Flip `CORE_READY` to `true`; scaffold test replaced by the suites above; `pnpm test` and `pnpm build` green.
