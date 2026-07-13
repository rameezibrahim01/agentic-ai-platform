# 047 — Kill switches from the console: the write path, designed and audited

**Packages:** `packages/storage` (ops audit) + `apps/console` · **Depends on:** 033, 038, 042 · **Allowed deps:** none new

## Context
033 deliberately left switch-flipping as a config-file edit until write-path auth was designed. The design, now that sessions/roles/tenancy exist: the limits FILE stays the single source of truth (the worker's mtime loader is untouched); the console gains ONE write action — flip a switch — gated on `manage_platform`, scoped by the session (a tenant admin flips their lane's file, the 042 operator names a tenant or the shared file), executed as an atomic file write, and recorded in a new append-only `ops_audit` table. An unaudited emergency lever is how audits are failed; this one leaves a row.

## Scope
1. Migration `005-ops-audit.sql`: `ops_audit(id bigserial pk, at bigint, principal text, action text, scope text, detail jsonb)` — append-only by convention (no update/delete paths in code); `OpsAuditStore` (`record`, `list`) InMemory + Postgres, schema-agnostic (per-deployment table like `accounts`).
2. Pure decision logic (`apps/console/src/lib/switches.ts`): `flipSwitch(currentConfig, {scope: "global" | {agent}, tripped})` → new LimitsConfig (validated, strict — a malformed current file refuses the flip rather than "fixing" it); `switchWriteTarget(session, tenanted, tenantParam?)` → which file may this session write: untenanted admin → shared file; tenant-bound admin → their lane's `limits.<id>.config.json` (created from the shared config on first flip); operator (042 identity) → a named tenant's lane file or the shared file; everyone else → refused.
3. `POST /api/limits/switch`: `manage_platform` required; resolves the target via the SESSION (the only tenant override is the operator's explicit form field, mirroring 042's write-scope); reads-validates-flips-writes the file ATOMICALLY (temp file + rename in the same directory); appends the ops_audit row (who, which switch, old→new, which file) BEFORE returning; failures are typed JSON.
4. `/limits` page grows the flip buttons (visible only to sessions the target resolution admits); the 033 "editing the mounted file" paragraph updates to name both paths. Compose mounts `limits.config.json` writable for the console (`:rw`) — the worker keeps `:ro`.
5. Tests: flip logic (global/per-agent, idempotent flips, malformed-file refusal); write-target matrix (untenanted admin, tenant admin, operator+param, viewer refused, approver refused); ops-audit store contract (both adapters, Postgres in CI); route-level flow over injected deps — flip writes the file, audit row lands, refused flips write NOTHING (no file change, no audit row… refusals may audit too — decide: refusals ARE audited with `action: "switch_flip_refused"`, matching the gateway's refuse-and-audit doctrine).

## Out of scope
Editing budget caps/rate limits from the web (switches only — the emergency lever), approval workflows for flips (a flip is one admin's emergency action; the audit row is the control), ops_audit retention (rows are tiny and load-bearing), UI polish.

## Acceptance criteria
- [ ] A `manage_platform` session can flip global and per-agent switches for exactly the files its scope admits; every other combination is refused (matrix test-pinned).
- [ ] The file write is atomic; the worker's existing loader picks the flip up without restart (mtime path untouched).
- [ ] Every flip AND every refused flip leaves an `ops_audit` row (who/what/old→new/which file); the table has no update/delete code path.
- [ ] `pnpm test`, `pnpm build`, console Next build green.
