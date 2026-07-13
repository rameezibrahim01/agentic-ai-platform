# 054 — Run launcher: start an agent from the browser

**Packages:** `apps/console`, `packages/auth`, `deploy/` · **Depends on:** 037, 038, 052 · **Allowed deps:** none new

## Context
Every run so far started from a shell (`demo-run.ts`), a schedule, or a webhook. The missing
surface is the obvious one: pick an agent, type an input, press run, watch the timeline. The
machinery already exists end-to-end — the console starts workflows by name (ticket 023's
`startAgentRunByName`), the run starter resolves alias → immutable spec (`demo-run.ts` is the
reference), the run detail page already renders the live timeline, and the approvals inbox
already handles the pause. This ticket is glue, done governedly: session-bound tenancy picks
the task queue and workflow id, the principal is the signed-in user (never a form field), and
launch is idempotent — a client-minted run id means double-submit lands on the same run.

## Scope
1. `packages/auth` roles: new action `start_runs` → `["agent_developer", "platform_admin"]`.
2. Pure core in `apps/console/src/lib/launch.ts`: `buildLaunch(config, request, session, env)`
   → resolves alias-or-version through the console's agents schema copy (same resolution rule
   as `resolveAgentAlias`: `name@vN` is itself, a bare name goes through the env pointer),
   builds the full run input from the spec (`model`, `prompt`, `budget`, `loopDetection`,
   `approvalTtlMs` — spec wins, the form cannot override budgets), sets
   `principal: "user:<session subject>"`, and derives workflowId/taskQueue through the
   existing tenancy helpers (`<tenant>--<runId>` + `agent-runs--<tenant>` in tenanted mode,
   plain in single-tenant). Input is a free-text field carried as `{ text }` plus an optional
   JSON object mode; both zod-validated. Typed refusals: unknown agent, no pointer for the
   console's env, malformed input JSON.
3. `/agents/[name]/run` page (linked from catalog + detail): shows the resolved version and
   its budget (what you're about to spend), input field, run button. The form carries a
   server-minted `runId` hidden field so resubmit/refresh is a duplicate, not a second run.
4. `POST /api/runs` route: session gate (`start_runs`) → `buildLaunch` → `startAgentRunByName`
   (existing duplicate-tolerant helper, extended to accept an explicit task queue) → redirect
   to `/runs/<runId>`. `"duplicate"` also redirects to the run — idempotency as UX.
5. Environment: the console launches with `PLATFORM_ENV` (compose already defaults prod for
   the worker; console gets the same variable so alias resolution matches the engine's policy
   env). Compose + Helm updated, render drill green.
6. Tests: resolution parity with the worker's rules (direct `@vN` vs pointer), spec-wins-over-
   form, principal comes from the session, tenanted vs single-tenant queue/id derivation,
   duplicate submit → same workflowId, role gate refusals.

## Out of scope
Streaming/SSE (the run page's existing refresh model stands), input schemas per agent,
run-as-another-principal, cross-tenant launches (session tenant only — operator launches are
a backlog note), canceling runs.

## Acceptance criteria
- [ ] A signed-in `agent_developer` picks an agent, types input, presses run, and lands on the
      live run timeline; a governed write pauses in the approvals inbox exactly like the demo.
- [ ] Double-submit of the same form lands on the SAME run (asserted via the duplicate path).
- [ ] The launch principal is the session user; budgets/model/prompt come from the immutable
      spec and cannot be overridden by the form (tested).
- [ ] Tenanted mode launches onto the tenant's queue with the tenant-qualified workflow id;
      single-tenant is byte-identical to `demo-run.ts` behavior (tested at the lib level).
- [ ] `pnpm test` and `pnpm build` green; compose + helm wiring updated.
