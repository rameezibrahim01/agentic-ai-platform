# 027 — Immutable agent versions + the eval harness

**Packages:** new `packages/evals` (pure) + `apps/worker` (scenario runner glue) · **Depends on:** 005, 016, 017 · **Allowed deps:** none new

## Context
Build-plan Phase 3(a)+(c) start here: an **agent version** becomes an immutable, first-class object (prompt, model, budget, loop config, expected tools), and every agent version owns a **golden scenario suite** with hard assertions — correct tool chosen, correct arguments, zero policy violations, outcome achieved, cost ceiling. Scenarios are harvested from the shapes real Phase 1–2 runs actually produced (the drill and demo event logs), not invented; synthetic suites certify nothing. The harness replays a scenario through the REAL activity pipeline (model gateway with a scripted provider, real tool gateway, real reducer) in-memory — the same machinery the secrets scan (022) proved out — so a passing eval means the governed path passed, not a mock of it.

## Scope
1. `AgentVersionSpec` in `packages/evals` (zod, `.strict()`, immutable by discipline): `{ id: "name@vN", prompt, model, budget?, loopDetection?, approvalTtlMs?, tools: ToolRef[] }` — `tools` documents intent; grants still come from deployment config.
2. `Scenario`: `{ name, world: { script: FakeBehavior[], env, grants?, approval?: "grant" | "deny" }, input, expect: { outcome: "completed" | "budget_exceeded", toolCalls?: [{ tool, args?: exact match }], policyViolations: 0, outcomeIncludes?: string, maxCostUsd? } }`.
3. `runScenario(agent, scenario)` in `apps/worker/src/evals/runner.ts`: drive the activity loop directly (startRun → callModel → resolveIntent → [scripted approval decision] → completeRun / budget failure) against an in-memory world — no Temporal needed, so evals run everywhere, fast. Returns the event log + a verdict per assertion with a legible diff (`expected ticket.update@v1{id:42} — got crm.delete@v1{...}`).
4. `runSuite(agent, scenarios)` → `{ passed, failed, results[] }`; failures render as the block CI will print (027 builds the harness; 028 wires the gate).
5. Golden suites for the two agents the platform actually has — the demo write agent (021) and the scheduled triage agent (020's drills) — with scenarios harvested from their recorded event chains, including one adversarial scenario each (out-of-grant intent must be refused-and-audited, loop must be killed by budget).
6. Out-of-scope marker tests: an assertion on `policyViolations: 0` FAILS if any `PolicyEvaluated` in the log is a gateway refusal deny — refusals in eval runs are failures unless the scenario explicitly expects them.

## Out of scope
LLM-as-judge rubrics (needs a real judge model — lands with 029's sampling), CI gating and promotion (028), scenario recording UI, trace-diff tooling.

## Acceptance criteria
- [ ] Agent versions are zod-validated immutable specs; suites live beside them in-repo.
- [ ] `runScenario` drives the real gateway pipeline; a scenario can assert tool choice, exact args, policy cleanliness, outcome text, and cost ceiling — each failure with a legible diff.
- [ ] Golden suites pass for the demo write agent and the triage agent, including the adversarial scenarios (refusal + loop kill asserted from the log).
- [ ] A deliberately broken agent spec (wrong prompt behavior via a mismatched script) fails its suite with the diff naming what diverged.
- [ ] `pnpm test` and `pnpm build` green.
