# 014 — Tool registry

**Package:** new `packages/tool-registry` · **Depends on:** 001 · **Allowed deps:** `@platform/core`, `zod`

## Context
Phase 2 workstream (a), architecture §6: every tool is a versioned, typed contract with a risk tier, and tiers are the input to policy — not documentation. This registry is the in-process system of record the tool gateway (016) consults; wrapping external MCP servers arrives later and inherits this shape.

## Scope
1. `ToolContract`: `{ name, version, description, risk: RiskTier, input: zod schema, output: zod schema, egress: string[] }` — `name@version` is the identity; `egress` declares every external host the tool may reach (empty = none).
2. `ToolRegistry` (pure, in-memory):
   - `register(contract)` — typed result; re-registering an existing `name@version` is a **typed refusal** (versions are immutable, architecture §3);
   - `get(name, version)` → contract | typed not-found;
   - `validateInput(ref, args)` / `validateOutput(ref, value)` — both directions, zod issues surfaced, never a throw (malformed intents never reach systems; malformed results never reach the context window unlabeled).
3. **Grants**: `AgentGrants = { agent, tools: ToolRef[] }`; `hasGrant(grants, agent, ref)` — exact `name@version` match only; no wildcard grants in Phase 2.
4. Serializable form: contracts expose `describe()` → plain JSON (name, version, risk, egress, human description) for audit/console use — schemas stay runtime-only.

## Out of scope
MCP server wrapping, persistence of the registry (config-as-code for now), the gateway itself (016), policy (015), wildcard/tier-based grants.

## Acceptance criteria
- [ ] Registering a duplicate `name@version` returns a typed refusal and leaves the original untouched; different versions of the same tool coexist.
- [ ] Property test: for arbitrary args, `validateInput` accepts exactly what the contract's schema accepts and surfaces zod issues otherwise; same for `validateOutput`.
- [ ] Grant checks are exact-match on `name@version`: same name/different version is refused.
- [ ] `describe()` output is JSON-serializable and carries no schema internals.
- [ ] `pnpm test` and `pnpm build` green.
