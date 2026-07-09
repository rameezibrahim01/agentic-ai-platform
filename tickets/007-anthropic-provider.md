# 007 — Anthropic provider

**Package:** `packages/model-gateway` · **Depends on:** 004 · **Allowed deps:** none new (Node ≥20 global `fetch`; the Anthropic SDK is deliberately NOT added — the provider is a thin HTTP client behind 004's interface)

## Context
Architecture §5: real model traffic flows through the gateway built in 004. This ticket adds the first real `ModelProvider`. The FakeProvider remains the default in every test — no test performs real network I/O.

## Scope
1. `AnthropicProvider` implementing `ModelProvider` against the Messages API (`/v1/messages`):
   - constructor takes `{ apiKey, baseUrl?, timeoutMs?, maxRetries?, fetchFn? }` — `fetchFn` injectable so tests use a fake fetch, never the network;
   - API key comes from env at the **call site** (`ANTHROPIC_API_KEY`), is held privately, and never appears in any log, event, error message, or thrown object;
   - bounded retries with backoff on 429/5xx/network errors (`maxRetries`, default 2); 4xx other than 429 fails immediately with a typed error;
   - per-request timeout via `AbortController`;
   - response mapping: text content → `{ kind: "message" }`; `tool_use` block → `{ kind: "tool_intent" }` with raw input (the gateway validates it, 004); usage mapped to `{ tokensIn, tokensOut }`.
2. Factory `createAnthropicProviderFromEnv()` reading `ANTHROPIC_API_KEY` (and optional base URL) — the only place env is touched.
3. A **secrets-scan test** (CLAUDE.md #4): drive the provider through the full gateway with a seeded fake key; capture every gateway log entry, every emitted event payload, and every error thrown by scripted failures — assert the key material appears in none of them.

## Out of scope
Streaming, prompt caching, system prompts/tool definitions beyond a minimal prompt shape, response caching, the real network in tests.

## Acceptance criteria
- [ ] Contract test with fake fetch: request carries `x-api-key`/`anthropic-version` headers and the prompt; text response maps to `message`, `tool_use` response maps to `tool_intent` with raw input passed to the gateway for validation.
- [ ] Retry test: fake fetch scripted 429 → 500 → 200 succeeds after 2 retries; a persistent 500 fails after `maxRetries` with a typed error; a 400 fails immediately with no retry.
- [ ] Timeout test: a hanging fake fetch is aborted at `timeoutMs` and treated as a provider failure (gateway fails over, per 004).
- [ ] Secrets-scan test green: seeded key material never appears in gateway logs, events, or error text — including when requests fail.
- [ ] FakeProvider remains the default everywhere else; no test touches the real network; `pnpm test` and `pnpm build` green.
