# 064 — Cancel a run from the console

**Packages:** `apps/worker`, `apps/console` · **Depends on:** 033, 047, 054 · **Allowed deps:** none new

## Context
An operator watching a run go wrong today has two levers: the per-agent kill switch (stops
EVERY run of that agent) and the global one (stops everything). A pilot needs the surgical
version: stop THIS run, leave its siblings alone. The machinery already exists — the engine
checks the limits file at every step (033) and the console already owns one audited write to
that file (047). This ticket adds a `runs` scope to the same switch, a cancel button on the
run page, and nothing architecturally new: cancellation is a kill switch with a narrower
blast radius, enforced by the engine, never by asking the model to stop.

## Scope
1. `apps/worker/src/limits.ts`: `killSwitches` gains `runs: z.record(z.boolean()).default({})`
   (additive — existing limits files parse unchanged). `checkKillSwitch` takes the runId and
   trips on `runs[runId]` with a `detail` that names the run. The engine's existing per-step
   check needs no new call sites: a cancelled run stops at its NEXT step, typed and audited in
   the event log exactly like the 033 drill. A run paused `awaiting_approval` dies on resume
   (approval or denial) — the pause itself stays a human decision point; state the semantics
   in the run page copy.
2. `apps/console/src/lib/switches.ts`: `consoleLimitsSchema` mirrors the new field;
   `FlipRequest` gains `{ scope: "run"; runId: string; tripped: boolean }` through the SAME
   `handleSwitchFlip` path — role-gated (`manage_platform`), tenant-scoped, ops-audited,
   refusals audited too (047 doctrine, unchanged).
3. `apps/console`: POST `/api/runs/[runId]/cancel` adapts the flip (content-negotiated like
   every form route — browsers get a 303, machines get JSON); the run page shows **cancel run**
   on `running`/`awaiting_approval` runs only.
4. Housekeeping: a cancelled run's switch entry is dead weight once the run ends — the flip
   handler prunes entries for runs whose status is terminal at write time (best-effort, the
   file stays small; no background job).
5. Tests: schema round-trip old/new limits files, `checkKillSwitch` run scope, flip path incl.
   refusal audit, route negotiation. Drill p5-1 gains a beat: launch a second run, cancel it
   from the API, assert the run ends typed (`RunFailed`) and ops_audit holds the flip.

## Out of scope
Cancelling the in-flight model call itself (the step boundary is the enforcement point, same
as budgets), un-cancel/resume of a cancelled run, bulk cancel, cancel reasons beyond the
audit trail's who/when.

## Acceptance criteria
- [ ] A running run cancelled from the console ends at its next step with a typed `RunFailed`,
      and the event log tells the whole story.
- [ ] The flip is in `ops_audit` with principal and run id; refused flips (role, tenant) are
      audited too.
- [ ] Limits files written before this ticket parse and behave identically (tested).
- [ ] Drill p5-1 exercises cancel end-to-end over HTTP.
- [ ] `pnpm test` and `pnpm build` green.
