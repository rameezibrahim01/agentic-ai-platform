# 017 — Approval flow in the engine

**Packages:** `apps/worker` (+ wiring `@platform/tool-gateway`) · **Depends on:** 016 · **Allowed deps:** none new

## Context
Phase 2 workstream (e), engine half; architecture §4: "pause for human is just an event the workflow awaits." The durable run must survive the wait (that is the whole point of event-sourced runs), and expiry defaults to deny (§8).

## Scope
1. Replace 003's stubbed `executeTool` path with the real tool gateway: `callModel` intent → workflow calls a `resolveIntent` activity that drives `handleIntent`, appending the gateway's audit payloads through the idempotent append (grant/egress/policy refusals become `ToolFailed` in the log; the run continues — the model is told, not crashed).
2. On `approval_required`: append `ToolIntentEmitted` + `PolicyEvaluated(require_approval)` + `ApprovalRequested { approverGroup, expiresAt }`, then the workflow **awaits a Temporal signal** (`approvalDecision`: granted/denied + `by` + optional comment) with a timer race — expiry appends `ApprovalDenied { by: "system:expiry" }` (deny by default, never hang).
3. Granted → `ApprovalGranted` then execution through the gateway's execute step (approved intents skip re-evaluation but still validate output); denied → `ApprovalDenied`, intent cleared, run continues.
4. Client helpers: `sendApprovalDecision(client, runId, decision)`; workflow signal definitions exported for the console (018).
5. Worker deps carry the gateway config (registry, grants, rules, executors) — `DEFAULT_RULES` with `PLATFORM_ENV` as the policy env.

## Out of scope
The console inbox UI (018), approver-group routing/notifications, batching, standing delegations, sandboxes.

## Acceptance criteria
- [ ] Approval-granted path: a `write`-tier intent in `prod` pauses the run (`awaiting_approval` in replayed state), a granted signal resumes it, the tool executes, the run completes — full event chain intent → policy → requested → granted → executed in order.
- [ ] Approval-denied path: denied signal appends `ApprovalDenied`, the tool never executes (executor spy), the run continues and completes.
- [ ] Expiry path: no signal before `expiresAt` → `ApprovalDenied` by `system:expiry`; the tool never executes.
- [ ] **Durability across the wait**: worker killed while `awaiting_approval`, a fresh worker + late signal completes the run with zero duplicated events (kill test, approval edition).
- [ ] Out-of-grant intents surface as `ToolFailed` refusals in the log and the run survives.
- [ ] CI runs all of it for real (ephemeral server; no skips in CI); `pnpm test` and `pnpm build` green.
