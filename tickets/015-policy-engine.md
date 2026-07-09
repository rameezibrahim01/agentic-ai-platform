# 015 — Policy engine

**Package:** new `packages/policy` · **Depends on:** 001, 014 · **Allowed deps:** `@platform/core`, `zod`

## Context
Phase 2 workstream (d), architecture §8: policy is code — every tool intent is evaluated against declarative rules and the decision is recorded **with the rule that fired** (that is what turns an audit from archaeology into a query). Start with fewer than ten rules; policy frameworks die of premature generality.

## Scope
1. `PolicyContext`: `{ agent, principal, tool: { name, version, risk }, env, argsDigest? }` — everything a Phase 2 rule may match on.
2. `PolicyRule`: data, not functions: `{ id, description, match: { env?, agent?, tool?, risk?: RiskTier[] }, decision: allow | deny | require_approval }` — every field of `match` optional; a rule matches when all present fields match.
3. `evaluatePolicy(context, rules)`: **first matching rule wins**, evaluated in order; result `{ decision, ruleId }` maps directly onto the `PolicyEvaluated` event payload. **No match → deny** with the reserved rule id `default-deny` — the absence of policy is never permission.
4. `DEFAULT_RULES` implementing the architecture §6 posture in <10 rules: reads auto-execute everywhere; writes auto-execute in `dev`, require approval in `prod`; `irreversible` and `financial` always require approval.
5. Pure and total: no clock, no I/O; every context yields exactly one decision.

## Out of scope
Cedar/OPA integration (this engine's rule shape is deliberately compatible with a later swap), argument-content matching, time-of-day rules, earned-autonomy promotion, per-tenant rules.

## Acceptance criteria
- [ ] Property test: `evaluatePolicy` is total and deterministic — every generated context yields exactly one decision with a rule id, twice over frozen inputs.
- [ ] Property test: with `DEFAULT_RULES`, no `irreversible` or `financial` intent ever evaluates to plain `allow`, in any environment.
- [ ] Environment split proven at the unit level: the identical write intent is `allow` in `dev` and `require_approval` in `prod` under `DEFAULT_RULES`.
- [ ] First-match ordering proven: a specific deny placed before a general allow wins; reordering flips the outcome.
- [ ] Empty rule list → `default-deny` for everything.
- [ ] `pnpm test` and `pnpm build` green.
