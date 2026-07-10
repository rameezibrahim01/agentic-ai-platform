# 034 — SSO federation: OIDC code flow over the 013 account floor

**Packages:** `packages/auth` (OIDC verification, pure) + `apps/console` (flow) · **Depends on:** 013 · **Allowed deps:** none new (JOSE verification hand-rolled for RS256 via node:crypto)

## Context
Build-plan Phase 4(a): federate the local accounts and roles that have existed since Phase 1 — the audit log's *who* becomes the enterprise IdP's *who*. Self-hostable rule holds (CLAUDE.md #8): any spec-compliant OIDC issuer (Keycloak-class, client-provided) works; nothing assumes a SaaS IdP. Local accounts remain as the break-glass path.

## Scope
1. `packages/auth` OIDC verification, pure + injected: `verifyIdToken(token, { issuer, audience, jwks, nowMs })` — RS256 signature via `node:crypto` `verify`, `iss`/`aud`/`exp`/`nonce` checks, typed failures (`bad_signature` / `wrong_issuer` / `wrong_audience` / `expired` / `bad_nonce` / `malformed`). JWKS is a passed-in document — fetching is the app's job.
2. Role mapping, config not code: `OIDC_CONFIG` (zod, mounted): `{ issuer, clientId, clientSecretEnv, rolesClaim, roleMap: { [claimValue]: PlatformRole[] }, defaultRoles }` — an IdP group grants platform roles only if the map says so; unmapped users get `defaultRoles` (viewer-class), never silent admin.
3. Console flow: `/api/oidc/login` (redirect with `state`+`nonce` in a short-lived signed cookie) and `/api/oidc/callback` (code exchange via injected fetch, id-token verification against cached JWKS, then the EXISTING 013 session is issued with the mapped roles — one session mechanism, two front doors). `/login` shows the SSO button only when configured.
4. Discovery + JWKS fetched once per boot from `<issuer>/.well-known/openid-configuration` with the same lazy-singleton pattern as other console config; failures are typed 502s, never a silent local-account fallback for an SSO-initiated login.
5. Tests: id-token verification matrix (signature/issuer/audience/expiry/nonce, keys generated in-test via `generateKeyPairSync`); role mapping incl. unmapped→default; callback handler unit-tested with injected fetch + JWKS (state/nonce mismatch refused); local login unchanged.

## Out of scope
SAML, SCIM provisioning (next batch seed), IdP-initiated flow, refresh tokens/silent renewal, JWKS rotation mid-session (re-fetch on boot only), multi-issuer.

## Acceptance criteria
- [ ] `verifyIdToken` rejects every tampered/mismatched/expired case with a typed reason (matrix + property test) and accepts a well-formed token.
- [ ] Roles come only from the config map; unmapped users get `defaultRoles`; the audit `who` is the IdP subject (`oidc:<sub>` principal form).
- [ ] Callback refuses state/nonce mismatches; success issues the standard 013 session — approvals and audit work unchanged.
- [ ] No `OIDC_CONFIG` → console behaves exactly as before (local accounts only).
- [ ] `pnpm test` and `pnpm build` green.
