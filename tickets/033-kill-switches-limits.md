# 033 — Kill switches, platform budget caps, and rate limits

**Packages:** `apps/worker` (engine enforcement) + `apps/console` (switch surface) · **Depends on:** 005, 028 · **Allowed deps:** none new

## Context
Build-plan Phase 4(h): when an agent misbehaves in production the operator needs a lever that works in seconds — per agent and global — plus platform-level ceilings no run request can talk its way past. All of it engine-enforced (CLAUDE.md #7): the model is never asked to slow down; the engine refuses to proceed.

## Scope
1. `LimitsConfig` (`deploy/limits.config.json`, zod, mounted like the other configs): `{ killSwitches: { global: boolean, agents: { [agentOrAlias]: boolean } }, budgetCaps?: BudgetPolicy, rateLimits?: { runsPerHourPerAgent?: number } }`.
2. **Kill switch, engine-enforced**: a `checkLimits` activity runs at run start AND before every model call (workflow change) — a tripped switch fails the run with a typed `KilledBySwitch` outcome recorded via the existing `BudgetExceeded`→`RunFailed` shape (`reason: "KilledBySwitch"` in `detail`; no new event types) — mid-flight runs stop at the next step, not just new runs.
3. **Budget caps**: platform caps MERGE with per-run budgets as a ceiling — `effectiveBudget = min(runBudget, cap)` field-wise; a run requesting more than the cap silently gets the cap (the engine enforces, the request does not negotiate).
4. **Rate limits**: runs-per-hour per agent counted from `RunStarted` events in the store (no new state) — the sliding window is the log itself; exceeding refuses the new run at start with a typed outcome.
5. Config reload without restart: the worker re-reads `LIMITS_CONFIG` on every `checkLimits` call (file mtime cache) — flipping the switch is editing the mounted file; seconds, not deploys.
6. Console: `/limits` page rendering the current switch/cap/limit state read-only (flipping stays a config edit — an ops action with file-level audit, not a web click, until roles are federated).
7. Tests: switch trips mid-flight (Temporal test — run paused between steps, flip switch, next step kills); cap merge matrix; rate limit refuses the N+1th run within the window and admits after it slides; malformed config fails boot.

## Out of scope
Per-tenant limits (no tenants), web-click switch flipping (needs write-path auth design — new issue when scoped), notification on trip, per-principal rate limits.

## Acceptance criteria
- [ ] Global and per-agent kill switches stop NEW runs at start and IN-FLIGHT runs at their next step, with a typed, audited outcome — proven by a Temporal test.
- [ ] Platform caps ceiling per-run budgets field-wise; the merge matrix is property-tested.
- [ ] Rate limit derives from the event log alone and refuses over-rate starts (window slide tested with injected clock).
- [ ] Switch flips take effect without worker restart (file-based reload, test-pinned).
- [ ] `pnpm test` and `pnpm build` green.
