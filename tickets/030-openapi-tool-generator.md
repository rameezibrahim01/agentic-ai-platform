# 030 — Connector scale kit: the OpenAPI→tool generator

**Packages:** `apps/worker` (generator + executor), `deploy/` · **Depends on:** 016, 024 · **Allowed deps:** none new (OpenAPI subset parsed with zod, HTTP via injectable fetch)

## Context
Build-plan Phase 3(g), architecture §6's second escape hatch: point at an OpenAPI spec, receive governed tools — turning "can you connect to X" from an engineering project into configuration. Same trust posture as 024: the spec describes shapes, but **config confers authority** — only operations the deployment config names become tools, risk is assigned by config (never inferred from HTTP method), and egress is pinned to the spec's server host, which must itself be allowlisted.

## Scope
1. `apps/worker/src/openapi/generate.ts`: given a parsed OpenAPI 3.0 document (local JSON file — the platform ships to client sites; no spec fetching) and a config entry per operation `{ operationId, version, risk, egress?: override }`, produce `{ contract, executor }`: input schema from parameters + requestBody (reusing 024's `jsonSchemaToZod`, strict; `$ref` into `#/components/schemas` resolved, anything else fails boot), output as a labeled `{ status, body }` envelope validated against the declared 2xx response schema when present.
2. HTTP executor with **injectable fetch**: path/query/body assembly from validated args; server-side secrets (016) become the auth header per a config-declared scheme (`bearer` / `header:<name>`); the URL host comes from the spec's `servers[0]` and is declared as the contract's egress — the gateway's egress allowlist decides if it is reachable in this environment.
3. `tools-config.ts` grows `openapiTools: [{ spec: <path>, operations: [...] }]` — same boot-failure discipline: unknown operationId, unsupported schema, or host mismatch fails boot loudly.
4. Fixture: a small OpenAPI document for a fictional ticketing API (`deploy/fixtures/ticketing.openapi.json`) with a read (`getTicket`) and a write (`closeTicket`) operation, used by tests and mountable in the artifact.
5. Tests: generation from the fixture (schemas strict both directions); executor request assembly (URL, query, body, auth header from injected secrets — never in args or audit payloads); inheritance proof like 024 (ungranted refused, prod write pauses, egress denied when the host is not allowlisted); `$ref` resolution; unsupported spec features fail boot.

## Out of scope
OpenAPI 3.1/Swagger 2, remote spec fetching, OAuth flows to target APIs, response pagination helpers, the connector SDK docs (follow-up), scoped read-only SQL tool.

## Acceptance criteria
- [ ] Config-listed operations become governed tools; unlisted operations do not exist; risk comes from config only.
- [ ] The executor's auth material comes from gateway secrets and appears in no intent, event, or audit payload (secrets-scan style assertion).
- [ ] Egress is pinned to the spec's server host and enforced by the existing gateway egress check (denied when unallowlisted — test-pinned).
- [ ] Generation failures (unknown operationId, unsupported schema feature, unresolvable $ref) are loud boot failures.
- [ ] `pnpm test` and `pnpm build` green.
