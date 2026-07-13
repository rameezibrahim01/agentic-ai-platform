# 055 — Promote & rollback from the console

**Packages:** `apps/console`, `deploy/` · **Depends on:** 028, 047, 053 · **Allowed deps:** none new

## Context
Versions are immutable; what moves is the pointer (028). The CLI already moves it
(`promote.sh` gated on green evals, `rollback.sh` ungated by design). The console gets the
same two levers with the same asymmetry — and one honesty rule: browser-built agents (053)
have no golden eval suite, so the console cannot pretend to run the CI gate. Instead it says
so out loud: promoting a version with no in-repo suite marks the action `evalStatus:
"unproven"` in the confirm copy and in the ops_audit record. The CI evals job keeps guarding
repo-shipped agents exactly as before; the console never edits version specs, only pointers,
so 028's digest discipline is untouched.

## Scope
1. Pure core in `apps/console/src/lib/promote.ts`: `movePointer(config, {name, env, to})` →
   next config with `current: to, previous: <old current>`; `rollbackPointer(config, {name,
   env})` → swaps back to `previous` (refuses when none is recorded). Both refuse unknown
   versions/aliases and malformed current files (047's rule: the lever never "fixes" config).
   Append-only versions asserted structurally, same property as 053.
2. Eval-awareness, honest and cheap: the repo's suite registry (the eval harness's known
   agent ids) is exported as a static JSON manifest generated at build time in-repo
   (`apps/console/src/lib/eval-manifest.json`, refreshed by a script + a test that fails when
   it drifts from `packages/evals` suites). `evalStatusFor(id)` → `"suite-green-in-ci" |
   "unproven"` — copy shown in the confirm UI and stamped into the audit record.
3. `/agents/[name]` gains per-env controls: promote (version picker) and rollback (shows what
   it restores). Both `POST /api/agents/pointer` route → session gate → pure core → 047 write
   path (validate, rename-with-fallback) → ops_audit (refusals too, with from/to pointers).
4. Gates: dev pointer moves require `author_agents`; prod pointer moves require
   `manage_platform` (operators own prod). Rollback is gated by role but NEVER by eval status
   — rollback must never be blocked, in any surface.
5. Coexistence note (documented in the ticket + DEPLOYMENT.md): the file is the single source
   of truth with last-writer-wins between `promote.sh` and the console; both sides validate the
   whole file before writing, so a concurrent edit can be lost but never corrupted.
6. Tests: pointer move records previous; rollback restores and refuses when nothing to restore;
   prod vs dev role gates; unproven-version promote carries the marker into the audit record;
   manifest-drift test; malformed-file refusal.

## Out of scope
Running evals from the console (CI's job), canary/traffic splitting, editing version specs
(immutable), multi-file transactional writes, per-tenant pointers.

## Acceptance criteria
- [ ] Promote and rollback work from `/agents/[name]` per environment; every move — and every
      refusal — is in `ops_audit` with actor, alias, env, from → to.
- [ ] Rollback restores `previous` in one click, ungated by eval status; promote of a version
      with no in-repo suite is allowed but visibly and audibly marked `unproven`.
- [ ] Dev moves need `author_agents`; prod moves need `manage_platform` (tested both ways).
- [ ] The eval manifest is generated, and a test fails when it drifts from the real suites.
- [ ] `pnpm test` and `pnpm build` green.
