# 029 — Online sampling + cost-per-outcome

**Packages:** `apps/console` (dashboards), `apps/worker` (sampler), `packages/evals` (judge rubric shape) · **Depends on:** 008, 027 · **Allowed deps:** none new

## Context
Build-plan Phase 3(e)+(f): the offline gate (028) catches regressions before deploy; this ticket watches what actually ships. A sampler scores a percentage of completed prod runs asynchronously — rubric scores from an LLM judge with a **pinned judge model**, drift counters from the log itself — and the console answers the sentence that renews contracts: *"$X per resolved outcome."* Everything derives from the event log (state = reducer(events)); scores are stored as NEW appended facts, never mutations of past events (CLAUDE.md #5).

## Scope
1. `JudgeRubric` in `packages/evals`: `{ id, judgeModel (pinned, exact), criteria: [{ name, question, weight }] }` + `judgeRun(gateway, rubric, events)` — renders the run's audited transcript (from the log, provenance-labeled) into a judge prompt, parses a structured verdict (zod), returns `{ scores, judgeModel, rubricId }`. The judge goes through the model gateway like every other call: allowlisted, metered, redacted.
2. Sampler in `apps/worker` (`runSampler` — a plain async function invocable from a Temporal schedule or CLI): pick completed runs without a score (deterministic sampling by `hash(runId) % rate`), judge them, and append a `RunScored`-shaped record to a **separate** score store (in-memory + Postgres table `run_scores`; the run event log itself is untouched — scores are observations about runs, not run events).
3. Drift counters as a pure view over the store: per agent over a window — tool-failure rate (`ToolFailed` / `ToolExecuted`), refusal rate (gateway denies), budget-kill rate, mean judge score; `driftAlarms(view, thresholds)` returns typed alarms (no notification plumbing — surfacing is the console).
4. Console `/costs`: per-agent table — runs, completion rate, total/mean cost, **cost per completed outcome** (total cost ÷ completed runs), judge-score mean where sampled, alarms rendered plainly. Pure viewmodels, unit-tested like `runListView`.
5. Tests: sampling determinism (same store, same rate → same picks; no double-scoring), judge round-trip with a scripted provider, drift math on constructed logs, cost-per-outcome arithmetic pinned against the reducer's totals.

## Out of scope
Automatic rollback on drift (canary remains deferred), notification routing, per-tenant views (Phase 4), score-history UI beyond the table.

## Acceptance criteria
- [ ] Judge rubrics carry a pinned judge model; judging goes through the gateway (allowlist + metering enforced in tests).
- [ ] Sampler scores a deterministic subset exactly once each; scores live in a separate store; the run event log is byte-identical before/after.
- [ ] Drift counters and alarms derive purely from logs + scores; thresholds injected.
- [ ] `/costs` states cost-per-completed-outcome per agent, matching reducer totals exactly (test-pinned).
- [ ] `pnpm test` and `pnpm build` green.
