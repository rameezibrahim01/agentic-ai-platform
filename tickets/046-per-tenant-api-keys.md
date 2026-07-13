# 046 — Per-tenant provider API keys: BYO key per lane

**Packages:** `apps/worker` · **Depends on:** 026, 041 · **Allowed deps:** none new

## Context
041 gave each tenant its own model allowlist and pricing; the provider CREDENTIAL stayed deployment-level (`ANTHROPIC_API_KEY`). Enterprise tenants bring their own keys — for billing separation and for blast-radius (revoking one tenant's key must not touch another). The pattern is already proven twice (036 data keys, 040 SCIM token): config names an env var, env carries the material, named-but-empty refuses boot.

## Scope
1. `modelsConfigSchema` gains optional `apiKeyEnv` (the env var NAME holding that config's Anthropic key — never the key itself). `buildModelGateway` resolves it: `apiKeyEnv` present and populated → that key builds the real provider; named-but-empty → typed build failure (the worker turns it into a boot failure); absent → the setup's `apiKey` (today's `ANTHROPIC_API_KEY`) as before.
2. Worker lane wiring (041's path): a tenant's `models.<id>.config.json` with `apiKeyEnv` gives that lane its own provider credential; the shared config may use `apiKeyEnv` too (untenanted deployments get the same knob). `ANTHROPIC_API_KEY` remains the fallback — byte-identical for every existing deployment.
3. Key hygiene holds: the key reaches ONLY the provider constructor; summaries/logs/errors name the env VAR at most, never material (extend the existing 026 pins).
4. Tests: schema (apiKeyEnv optional, strict elsewhere); resolution matrix (env populated → anthropic provider present; named-but-empty → typed failure; absent → fallback key; neither → stub only); per-lane pin — acme's models config with `apiKeyEnv=ACME_ANTHROPIC_KEY` yields an anthropic-primary gateway while globex (shared, keyless) stays stub-only; no key material in any summary (scan).
5. `deploy/.env.example`: document the per-tenant key convention.

## Out of scope
Non-Anthropic providers (the gateway's provider list is already pluggable), KMS/secret-manager integration (env/mounted secret stays the interface), key rotation for provider keys (stateless — swap the env and restart the lane).

## Acceptance criteria
- [ ] `apiKeyEnv` in a models config selects that lane's provider credential; named-but-empty refuses boot; absent falls back to `ANTHROPIC_API_KEY` byte-identically.
- [ ] Per-lane pin: one tenant with its own key, another without — provider lists differ accordingly (test-pinned).
- [ ] Key material appears in no summary, log, error, or event (scanned).
- [ ] `pnpm test` and `pnpm build` green.
