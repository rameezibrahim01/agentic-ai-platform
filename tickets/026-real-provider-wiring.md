# 026 — Real Anthropic provider in the artifact

**Packages:** `apps/worker` (bootstrap), `deploy/` · **Depends on:** 007, 021 · **Allowed deps:** none new

## Context
The 007 provider exists and is fully tested against an injected transport, but the shipped worker still runs the stub model. This ticket wires the real provider into the bootstrap — key from env only (CLAUDE.md #4), models from config, stub behavior preserved byte-for-byte when no key is present so every existing drill and the artifact test keep running hermetically.

## Scope
1. Worker bootstrap: when `ANTHROPIC_API_KEY` is set, the model gateway gets the real `AnthropicProvider` (via `createAnthropicProviderFromEnv`) **in addition to** the stub — the stub stays registered as the failover, so a revoked/exhausted key degrades instead of breaking runs (the 005 failover path, now in production shape).
2. `MODELS_CONFIG` (env, JSON, zod-validated — same pattern as `TOOLS_CONFIG`): per-environment model allowlist and pricing table for real models; without it, only `stub-model` is allowed — a key alone must never widen the allowlist.
3. Compose: `ANTHROPIC_API_KEY` passed through from the host environment (`${ANTHROPIC_API_KEY:-}`, empty default), `MODELS_CONFIG` mountable; `.env.example` documents both without values. Nothing about the artifact test changes when the key is absent.
4. Boot log states which providers are active and which models are allowed — never the key, never any prefix of it (the 022 secrets scan already patrols this; extend its corpus with the boot log lines).
5. Tests: bootstrap provider selection under key/no-key × config/no-config (via a small pure `buildModelGateway(env vars)` helper extracted from `runWorker`); allowlist stays stub-only without `MODELS_CONFIG`; secrets-scan corpus covers the new boot lines.

## Out of scope
Streaming, prompt caching, second real provider (failover partner remains the stub until a second key exists), model routing rules beyond the allowlist.

## Acceptance criteria
- [ ] With `ANTHROPIC_API_KEY` + `MODELS_CONFIG`: real provider active, configured models allowed, stub is the failover — proven by unit tests with injected fetch.
- [ ] Without the key: byte-identical stub behavior; artifact test and all drills unchanged and green.
- [ ] A key with no `MODELS_CONFIG` does NOT widen the allowlist (test-pinned).
- [ ] No credential material in boot logs/events/traces — secrets-scan extended and green.
- [ ] `pnpm test` and `pnpm build` green.
