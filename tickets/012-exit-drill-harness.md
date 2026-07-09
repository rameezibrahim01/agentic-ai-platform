# 012 — Phase 1 exit-drill harness

**Packages:** `scripts/drills/`, `docs/drills/` · **Depends on:** 011 · **Allowed deps:** none new

## Context
Build plan: "a phase is complete when its exit drills pass, not when its features merge." Drills 1–4 already exist as CI test suites but scattered; drill 7 landed in 011. This ticket makes every Phase 1 drill a named, recorded, repeatable artifact — one command each — and records the results, so the phase gate is a checklist backed by evidence instead of memory.

## Scope
1. `scripts/drills/run-all.sh` + one script per drill mapping each to its executable proof:
   - **drill-1-kill.sh** — the kill test (runs the CI-proven suite `apps/worker/test/workflow.test.ts` kill case).
   - **drill-2-budget.sh** — adversarial loop + cost-cap cases.
   - **drill-3-failover.sh** — gateway failover cases (`packages/model-gateway` failover tests).
   - **drill-4-audit.sh** — for a run id, reconstruct every step with tokens/cost from the log and verify totals equal the reducer's (console view-model tests + a compose-profile curl when available).
   - **drill-6-schedule.sh** — schedule policy suite (timezone pinning, skip-if-running, catch-up).
   - **drill-7-artifact.sh** — delegates to `scripts/artifact-smoke.sh` (011).
   Each script prints PASS/FAIL and its evidence source (test file or live assertion); drills that need Docker or the ephemeral Temporal server say so and fail loudly rather than fake a pass.
2. `docs/drills/phase-1.md` — the drill record: what each drill proves, how to run it, latest evidence (CI run links), and the two drills that are **explicitly not machine-checkable** — drill 5 (usefulness: the design partner consults the output weekly) and the invoice half of drill 4 (totals vs provider invoice) — marked as owner-verified with space to record the verification.
3. CI job `drills` running `run-all.sh` so the phase gate is continuously enforced, not a one-time ceremony.

## Out of scope
New functionality; Phase 2 drills; the design-partner usefulness assessment itself (human-owned).

## Acceptance criteria
- [ ] Every machine-checkable Phase 1 drill (1, 2, 3, 4-log-half, 6, 7) has a named script that exits 0 on pass and nonzero with a legible reason on fail.
- [ ] `run-all.sh` prints a drill-by-drill PASS/FAIL summary and exits nonzero if any machine-checkable drill fails.
- [ ] `docs/drills/phase-1.md` records the drill map including the human-owned items (drill 5, invoice reconciliation) with an owner and a place to record sign-off.
- [ ] CI job `drills` green.
- [ ] `pnpm test` and `pnpm build` remain green.
