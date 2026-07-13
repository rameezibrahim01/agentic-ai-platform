# 045 — Scoped read-only SQL tool: architecture §6's escape hatch, governed

**Packages:** `apps/worker` (catalog tool) · **Depends on:** 021, 016 · **Allowed deps:** none new (pg is already a worker dep)

## Context
Architecture §6 names the escape hatch every deployment eventually asks for: "let the agent query our database." Ungoverned, that is the single biggest data-exfiltration surface in the product. The governed form: a CATALOG tool (`sql.query@v1`, risk `read`) whose connection comes from a NAMED env var in config, whose enforcement is the database's own read-only transaction (never regex alone), and whose results are capped and digested like every other tool result. It does not exist unless TOOLS_CONFIG enables it, is not callable unless granted, and its egress list is empty — the pool is the only reach.

## Scope
1. Catalog entry `sql.query@v1` (`apps/worker/src/tools/sql.ts`): input `{ query: string, params?: unknown[] }` (zod, strict); output rows + rowCount + truncated flag. Config (`sqlTools` section or catalog option mirroring `notes.append`'s notesFile): `connectionEnv` naming the env var with the connection string — never the string itself; named-but-empty is a boot failure (the 036 rule).
2. Enforcement layers, in order: (a) single-statement floor — reject `;` outside quotes and any statement not beginning `SELECT`/`WITH`; (b) the REAL wall — every query runs inside `BEGIN TRANSACTION READ ONLY` with a server-side `statement_timeout`, so a smuggled write is a typed Postgres failure, not a regex race; (c) row cap (default 200) applied by cursor/limit with a `truncated` marker — results never balloon the event log (the gateway digests output as usual).
3. Failures are typed tool failures (audited `ToolFailed`), never worker crashes; the connection string appears in no event, log, or error (CLAUDE.md #4 — assert by scanning emitted audit payloads in tests).
4. Tests (vitest; Postgres-gated suite in CI): SELECT round-trip with params; INSERT/UPDATE/DELETE/DDL refused by the read-only transaction (typed); multi-statement refused at the floor; row cap + truncated flag; named-but-empty connection env refuses boot; ungranted agents refused-and-audited at the gateway (existing pipeline pins).
5. `deploy/`: document the config knob beside the other tool config docs (no default enablement — zero-config deployments keep zero tools).

## Out of scope
Non-Postgres engines (the connector SDK docs cover writing more), schema allowlists/column masking (real needs — new `type:design` issue when a partner asks), query planning/cost guards beyond timeout+cap, write tools of any kind.

## Acceptance criteria
- [ ] `sql.query@v1` exists only via TOOLS_CONFIG with `connectionEnv`; named-but-empty refuses boot.
- [ ] Writes are refused by the database's read-only transaction (test-pinned, all four verbs), multi-statements at the floor; failures are typed and audited.
- [ ] Row cap + truncated flag enforced; connection string absent from every emitted event/log/error (scanned).
- [ ] Gateway pipeline applies unchanged (grant required; refusals audited).
- [ ] `pnpm test` and `pnpm build` green.
