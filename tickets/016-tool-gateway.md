# 016 — Tool gateway

**Package:** new `packages/tool-gateway` · **Depends on:** 014, 015 · **Allowed deps:** `@platform/core`, `@platform/tool-registry`, `@platform/policy`, `zod` (Node `crypto` for digests)

## Context
Phase 2 workstream (b) — the crown jewels (architecture §6). No side effect bypasses this gateway (CLAUDE.md #2): the model emits intents; the gateway checks the grant, validates the schema, evaluates policy, injects secrets server-side, enforces egress, executes, and returns audit-ready event payloads. This ticket earns the red-team and grant exit drills at package level.

## Scope
1. `ToolExecutor`: `{ ref, execute(args, secrets): Promise<unknown> }` — injected per tool; `secrets` are provided by the gateway from its own store (`secretsFor(ref)` config), NEVER present in the intent, the events, or any log (CLAUDE.md #4).
2. `createToolGateway({ registry, grants, rules, executors, egressAllowlist, secrets, env, digest? })` with `handleIntent(request)` where request = `{ runId, agent, principal, intent: { tool, version, args } }`. Pipeline, in order, each step a typed refusal on failure:
   a. **grant check** — agent × `name@version` (out-of-grant is refused no matter what the model asked for);
   b. **input validation** — registry schema, zod issues surfaced;
   c. **egress check** — every host the contract declares must be in the env's allowlist;
   d. **policy** — `evaluatePolicy`; `deny` refuses, `require_approval` returns `{ kind: "approval_required", policy }` without executing;
   e. **execute** — executor invoked with server-side secrets; executor throw → typed `execution_failed`;
   f. **output validation** — registry schema; malformed results never pass unlabeled.
3. Every outcome returns audit-ready payloads: `ToolIntentEmitted` + `PolicyEvaluated` (+ `ToolExecuted` with sha256 args/result digests and latency, or `ToolFailed` with the refusal reason). Refusals are events too — **the attempt is always auditable**.
4. Red-team fixture: a "retrieved document" containing embedded instructions naming an out-of-grant tool; the test drives the resulting intent through the gateway and proves refusal on grant grounds with the attempt in the audit payloads (build-plan Phase 2 drill 3).

## Out of scope
Worker wiring (017), OAuth token exchange / delegated credentials (identity batch), MCP transport, compensation logic, approval persistence (the gateway only *reports* approval_required).

## Acceptance criteria
- [ ] Grant test: an intent for any tool outside the agent's grant is refused at the gateway regardless of arguments; the refusal is an audit payload, not a silent drop.
- [ ] Red-team test: the embedded-instruction fixture's exfiltration intent is refused on grant + egress grounds; audit payloads record the attempt.
- [ ] Egress test: a tool declaring a host absent from the env allowlist is refused before execution.
- [ ] Secrets test: seeded secret material reaches the executor but appears in no returned payload, event, or serialized gateway output.
- [ ] Property test: for arbitrary valid args, `ToolExecuted.resultDigest` is stable for identical results and differs for different results; malformed executor output yields `ToolFailed`, never an unvalidated result.
- [ ] `require_approval` intents return without executing (executor never invoked — proven with a spy).
- [ ] `pnpm test` and `pnpm build` green.
