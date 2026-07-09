# 004 — Model gateway: interface, fake provider, failover, metering

**Package:** `packages/model-gateway` · **Depends on:** 001 · **Allowed deps:** `@platform/core`, `zod` (Anthropic SDK explicitly NOT in this ticket)

## Context
Architecture §5: one gateway for all model traffic — abstraction, allowlist, failover, and the metering point. Built provider-agnostic and proven with fakes; the real Anthropic provider is a later, thin ticket.

## Scope
1. `ModelProvider` interface: `complete(request): ProviderResult` where result is `{ kind: "message" | "tool_intent", content | intent, usage: { tokensIn, tokensOut }, model }`.
2. `FakeProvider`: scripted responses, scripted failures/latency — the workhorse for every test here and in 003/005.
3. `createGateway({ providers, allowlist, pricing })`:
   - env-scoped **model allowlist** (request for a non-allowed model → typed refusal),
   - **failover**: primary error/timeout → fallback, recorded in the result,
   - **metering**: every call returns `{ costUsd, tokens }` computed from a pricing table; gateway emits a `ModelCalled` core event payload ready for the log,
   - **tool-intent parsing**: raw provider output validated with zod into `ToolIntentEmitted` payloads; malformed output → typed error, never a crash.
4. Redaction hook: a `redact(fn)` applied to anything the gateway logs (CLAUDE.md #4).

## Out of scope
Real network calls, caching, streaming, structured-output retries.

## Acceptance criteria
- [ ] Failover test: primary FakeProvider throws → fallback answers; result records `{ failedOver: true, from, to }`.
- [ ] Allowlist test: disallowed model is refused without touching any provider.
- [ ] Metering property test: for arbitrary usage numbers, cost math is exact and totals accumulate per run.
- [ ] Malformed tool-intent JSON from the fake yields a typed parse error and no partial intent.
- [ ] Redaction test: a seeded fake secret in a payload never appears in gateway log output.
- [ ] Flip `GATEWAY_READY`; `pnpm test` and `pnpm build` green.
