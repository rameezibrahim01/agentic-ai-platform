# Phase 1 exit drills — record

The build plan's rule: a phase is complete when its **exit drills pass**, not when its
features merge. This document is the drill map and sign-off record for Phase 1.
Machine-checkable drills run via `scripts/drills/run-all.sh` (also CI job `drills`);
a drill that cannot run in the current environment fails loudly — it never fakes a pass.

## Machine-checkable drills

| Drill | Proves | Command | Evidence source |
|---|---|---|---|
| 1 — kill test | Worker dies mid-run; a fresh worker completes the run from Temporal history with zero duplicated events | `scripts/drills/drill-1-kill.sh` | `apps/worker/test/workflow.test.ts` (kill case) |
| 2 — budget test | Adversarial looping is terminated by loop detection; a cost cap trips at the correct step; enforcement is the engine's, never the prompt's | `scripts/drills/drill-2-budget.sh` | worker adversarial cases + core budget/loop property suites |
| 3 — failover test | Primary provider failure/timeout degrades to the fallback with no failure surfaced | `scripts/drills/drill-3-failover.sh` | gateway failover cases + real-provider timeout failover |
| 4 — audit test (log half) | For any run id, every step reconstructs with tokens and cost; totals equal the reducer's exactly | `scripts/drills/drill-4-audit.sh` | console view-model suite |
| 6 — schedule test | Timezone-pinned firing, skip-if-running overlap, explicit catch-up decision | `scripts/drills/drill-6-schedule.sh` | `apps/worker/test/schedules.test.ts` |
| 7 — artifact test | The entire Phase 1 system boots on a clean machine from the compose profile with no egress beyond the model endpoint | `scripts/drills/drill-7-artifact.sh` | `scripts/artifact-smoke.sh` (CI job `artifact`) |

Latest evidence: the `drills` and `artifact` jobs on the most recent green `main` CI run.

## Human-owned drills (not machine-checkable — do not fake)

| Drill | What it requires | Owner | Sign-off |
|---|---|---|---|
| 5 — usefulness test | The design partner's team consults the agent's read-only output weekly without being chased. Requires a real design partner and a real workflow (build-plan Phase 0 strategic work — **not yet done**). | _unassigned_ | ☐ date / evidence: |
| 4 — invoice reconciliation | Console totals match the provider invoice within 2%. Requires real provider traffic (ticket 007's provider wired with a real key). | _unassigned_ | ☐ date / evidence: |

## Phase gate

Phase 2 opens when every machine-checkable drill is green on `main` **and** both
human-owned rows above are signed off. The machine half alone is not the gate.
