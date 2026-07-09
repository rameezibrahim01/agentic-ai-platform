# 019 — Delegation tokens + workload identity

**Package:** new `packages/identity` (+ integration in `packages/tool-gateway`) · **Depends on:** 013, 016 · **Allowed deps:** `@platform/core`, `@platform/auth`, `@platform/tool-registry`, `zod` (Node `crypto`)

## Context
Architecture §7, stated bluntly: *no agent ever holds a credential broader than the single action it is about to take*. Runs acting for a user hold delegated, scoped, time-boxed credentials — never the user's session, never a god-mode service account. Within this platform's boundary the delegation is an HMAC-signed token (the OAuth token-exchange shape arrives when a real IdP does in Phase 4); the invariants are identical and tested now.

## Scope
1. **Workload identity**: `workloadIdentityFor(agent, env)` → `platform://agent/<agent>/<env>` — distinct per environment, carried in delegation claims as the presenter.
2. **Delegation tokens** (pure apart from crypto, clock injected — same discipline as `@platform/auth` sessions):
   - `mintDelegation({ principal, agent, env, runId?, tools: ToolRef[], risks: RiskTier[] }, ttlMs, secret, nowMs)` — scope-minimized: named tool versions and a risk ceiling, time-boxed;
   - `verifyDelegation(token, secret, nowMs)` → typed `valid | expired | tampered | malformed`;
   - `delegationCovers(claims, ref, risk)` — exact tool match AND risk within scope.
3. **Tool-gateway integration**: optional `delegation?: string` on `IntentRequest`; gateway option `delegation: { required: true, secret }`. When required, verification and coverage run **before the grant check**; failures are typed, audited refusals (`delegation_missing | delegation_invalid | delegation_out_of_scope`) with the same Intent → PolicyEvaluated(deny, `gateway:<code>`) audit shape as every other refusal. The delegated principal must equal the request principal.
4. Worker pass-through: `AgentRunInput.delegation?` carried into `resolveIntent`/`executeApprovedIntent` requests untouched (the workflow never inspects credentials).

## Out of scope
Real OAuth/OIDC token exchange (Phase 4 federates this), standing grants (020), credential storage/rotation, mTLS/SPIFFE plumbing.

## Acceptance criteria
- [ ] Property tests: delegation round-trip is deterministic; expires exactly at ttl; any single-character tamper is rejected; a token minted with another secret is `tampered`.
- [ ] Scope tests: coverage requires the exact `name@version` AND risk within the ceiling — a delegation for `crm.lookup@v1 [read]` never covers `crm.lookup@v2`, another tool, or a `write` action.
- [ ] Gateway with `delegation.required`: missing/invalid/out-of-scope delegations are refused **before** grant/policy with audited payloads; a valid covering delegation proceeds through the unchanged pipeline; principal mismatch is refused.
- [ ] Without `delegation.required` the gateway behaves exactly as before (016 suite untouched and green).
- [ ] `pnpm test` and `pnpm build` green.
