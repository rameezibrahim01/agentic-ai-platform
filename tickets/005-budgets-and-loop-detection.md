# 005 — Budgets + loop detection

**Packages:** `packages/core` (policy + events) and `apps/worker` (enforcement) · **Depends on:** 001–004 · **Allowed deps:** none new

## Context
Architecture §4 and build-plan exit drill #2: runaway runs are terminated by the **engine**, never by asking the model nicely (CLAUDE.md #7).

## Scope
1. `BudgetPolicy` in core: `{ maxSteps, maxTokens, maxCostUsd, maxWallMs }` + pure `checkBudget(state, policy, nowMs): Ok | Exceeded(reason)`.
2. Loop detector in core: sliding window over `ToolIntentEmitted` — same tool + normalized-args hash appearing `N` times (default 3) → `LoopDetected` reason. Normalization: stable key order, trimmed strings, numbers rounded per config.
3. Worker enforcement in the `agentRun` loop: on `Exceeded`/`LoopDetected`, append `BudgetExceeded` then `RunFailed(reason)` and stop — replacing 003's hard-coded guard. Wall-clock uses workflow time (determinism rule from 003).
4. Gateway usage from 004 feeds token/cost totals via the reducer — no separate accounting.

## Out of scope
Per-tenant budgets, config UI, alerting.

## Acceptance criteria
- [ ] Property test (core): for arbitrary event streams and policies, the reducer's totals never exceed policy once enforcement events are interleaved per the rules — and `checkBudget` is pure and deterministic.
- [ ] Adversarial test (worker + FakeProvider scripted to loop forever): run terminates in ≤ N+1 identical intents with `RunFailed(LoopDetected)` in the log.
- [ ] Cost-cap test: scripted expensive usage trips `maxCostUsd` at the correct step; log shows `BudgetExceeded` before `RunFailed`, nothing after.
- [ ] Near-identical args (whitespace / key order) are caught by normalization; genuinely different args are not.
- [ ] `pnpm test` and `pnpm build` green across the workspace.
