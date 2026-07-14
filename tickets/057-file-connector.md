# 057 — File & spreadsheet connector: agents that read the department's folder

**Packages:** `apps/worker`, `deploy/` · **Depends on:** 016, 041, 045 · **Allowed deps:** `csv-parse` (worker)

## Context
Every market conversation (internal departments, government, partners) hits the same wall:
the demo tools are stand-ins. A real accounts or HR department lives in folders of files and
spreadsheets. This ticket gives agents a governed way in: read-only tools over a mounted
documents folder, CSV parsing, and ONE governed write — append a row to a spreadsheet in a
separate writable directory. Same doctrine as the SQL tool (045): the connector exists only
when the deployment config names it, reads are structurally incapable of writing (separate
roots, not politeness), and the write is a normal gateway intent that pauses for approval in
prod. File contents are external data, never instructions (CLAUDE.md #6).

## Scope
1. `toolsConfigSchema` gains `fileTools: { docsDir, dataDir? }` (`.strict()`): `docsDir` is the
   read-only root, `dataDir` the SEPARATE writable root for appends. Absent = the tools do not
   exist; a configured dir that is missing at boot refuses boot loudly.
2. `docs.list@v1` (risk read): relative paths + size + mtime under `docsDir`, recursive,
   capped (200 entries, `truncated` flag), symlinks never followed out of the root.
3. `docs.read@v1` (risk read): `{path}` → text for `.txt/.md/.csv/.json/.log`; 256 KiB cap with
   `truncated` flag; path traversal (`..`, absolute, symlink escape) refused typed; unknown or
   binary extensions refused typed, never dumped raw.
4. `sheet.read@v1` (risk read): `{path, limit?}` → `{header, rows, truncated}` via `csv-parse`
   (500-row cap), same root + traversal rules as docs.read.
5. `sheet.append@v1` (risk **write**): `{path, row: string[]}` → one properly CSV-escaped line
   appended under `dataDir` ONLY (a docsDir path is refused). Prod pauses it for approval —
   the notes.append of real work. At-least-once safety follows the notes.append precedent
   (engine-level ToolExecuted dedup).
6. Worker boot registers contracts + executors from config (egress `[]` — files never leave
   the box), with the established "tools enabled" boot-log shape.
7. `deploy/`: `demo-docs/` seed folder (2 sample invoice CSVs + a memo .txt — fabricated data,
   clearly marked), mounted ro at `/data/docs`; a `sheets` volume at `/data/sheets` for
   appends; `tools.config.json` names `fileTools` and the demo grants.
8. Tests: traversal/symlink refusals, caps + truncated flags, CSV round-trip incl. quoted
   commas/newlines, append escaping, docsDir-write refusal, boot refusal on missing dir, and a
   gateway integration test: `sheet.append` auto-executes in dev, pauses in prod.

## Out of scope
PDF/XLSX extraction (backlog — real invoices are PDFs; the floor is text-family), uploads via
the console, per-tenant file roots, watching/triggering on file changes.

## Acceptance criteria
- [ ] With `fileTools` configured, an agent can list/read documents and read CSVs — all capped,
      all refusing traversal; without it, the tools do not exist.
- [ ] `sheet.append` writes exactly one escaped row under `dataDir` after prod approval, and is
      refused typed for any docsDir target (tested both ways).
- [ ] Boot refuses loudly on a named-but-missing directory; the boot log names the enabled tools.
- [ ] Compose ships the seed folder + mounts; `pnpm test`/`pnpm build` green.
