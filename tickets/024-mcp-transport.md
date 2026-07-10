# 024 — MCP transport: wrap an external MCP server behind the gateway

**Packages:** `apps/worker` (transport + catalog integration), `deploy/` · **Depends on:** 014, 016, 021 · **Allowed deps:** none new (JSON-RPC over stdio is hand-rolled; no MCP SDK)

## Context
Architecture §6: any system becomes connectable by wrapping it as an MCP server — and the moment it is wrapped it inherits the entire governance stack (grants, risk tiers, policy, approvals, audit, egress) with zero additional integration logic. This ticket proves that sentence executable: a minimal MCP client (JSON-RPC 2.0 over stdio — the self-hostable transport; no SaaS, CLAUDE.md #8) turns tools of an external MCP server into registry contracts + executors behind the 016 gateway. Trust is explicit: nothing an MCP server advertises is registered unless the deployment config names it and assigns its risk tier — external metadata is data, not authority (CLAUDE.md #6).

## Scope
1. `apps/worker/src/mcp/client.ts`: `McpStdioClient` — spawn a configured command, speak JSON-RPC 2.0 over stdio (`initialize`, `tools/list`, `tools/call`), request ids + timeouts, typed errors; no retries (the gateway audits failures as `ToolFailed`).
2. `apps/worker/src/mcp/wrap.ts`: given the client and a **config entry per tool** `{ name, version, risk, description?, egress }`, produce `{ contract, executor }` pairs — input schema from the server's `tools/list` JSON Schema (converted to a zod validator; unconvertible schemas → boot failure, never silently permissive), output validated as MCP content, executor calls `tools/call`. **Risk is assigned by config, never taken from the server**; a tool the server advertises but config omits simply does not exist.
3. `tools-config.ts` grows `mcpServers: [{ name, command, args?, tools: [...] }]` — wrapped tools join the same registry/grants/egress build; name collisions with catalog tools are a boot failure.
4. A reference MCP server in-repo (`apps/worker/src/mcp/reference-server.ts`, ~stdio JSON-RPC echo/notes tool) used by tests and the artifact: compose config wraps one tool from it, granted to the demo agent, so the artifact demonstrates a wrapped external system end-to-end.
5. Tests: round-trip against the reference server (spawned as a child process); the wrapped tool is refused without a grant, requires approval as `write` in prod, and is delegation-checked exactly like a native tool (inheritance proof); malformed server output never passes unlabeled (`invalid_output`); advertised-but-unlisted tools are not registered.

## Out of scope
HTTP/SSE transport, OAuth to MCP servers, MCP resources/prompts (tools only), auto-registration of advertised tools, connector SDK / OpenAPI generator (Phase 3), sandboxing of server processes.

## Acceptance criteria
- [ ] An external MCP server's tool executes through the full pipeline — grant → schema (both directions) → egress → policy → (approval) → audit — with no gateway changes.
- [ ] Config assigns risk and selects tools; advertised-but-unlisted tools do not exist; unconvertible input schemas fail boot loudly.
- [ ] Inheritance proven by tests: ungranted → `not_granted`; prod write → `require_approval`; delegation-required world refuses without a covering delegation.
- [ ] The compose artifact wraps a reference-server tool via config only (no worker code changes beyond this ticket).
- [ ] `pnpm test` and `pnpm build` green.
