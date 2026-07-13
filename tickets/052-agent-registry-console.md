# 052 — Agent registry in the console (read surface)

**Packages:** `apps/console`, `deploy/` · **Depends on:** 028, 038 · **Allowed deps:** none new

## Context
Architecture §3's control-plane console includes the agent registry — but today the registry
(`agents.config.json`, ticket 028) is visible only to people who can read JSON over a shell.
The authoring layer starts here: before anyone can *create* an agent in the browser (053) or
*run* one (054), the console must show what exists — every version, every environment pointer,
in plain language. This is a pure read surface: the file stays the single source of truth, the
console reads it fresh per request (no cache — promote.sh edits must show up on reload), and a
malformed file renders as a loud error page, never a silent empty list.

## Scope
1. `apps/console/src/lib/agents.ts`: a console-side copy of the agents-config schema (same
   duplication rule as `consoleLimitsSchema` — the worker package never enters the Next bundle),
   plus pure viewmodels: `agentCatalog(config)` → aliases with per-env pointers (current /
   previous), the version list per name (newest first), and orphan versions with no alias.
   `readAgentsConfig(env, readFile)` reads the path named by `AGENTS_CONFIG` per request;
   missing env var → a typed "not configured" result, malformed file → typed error carrying the
   zod issues (never a throw across the boundary).
2. `/agents` page: the catalog — one row per alias: description of the current version,
   model, tool count, per-env pointer badges (e.g. `dev → demo-agent@v1`). Session-gated like
   every page; any signed-in role may read (`view_runs`).
3. `/agents/[name]` page: version history for one name — each version's full spec rendered as
   labeled fields (prompt, model, budget, loop detection, approval TTL, tools with risk), which
   env pointers reference it, and which version is `previous` (what rollback would restore).
4. Nav link from the console home; runs pages link agent ids back to `/agents/[name]`.
5. `deploy/docker-compose.yml`: mount `agents.config.json` into the console (ro in this ticket;
   053 flips it) and set `AGENTS_CONFIG`. `deploy/helm`: same wiring in the console deployment,
   render-verified by the existing drill.
6. Tests: viewmodel unit tests (catalog shape, orphan versions, malformed-file error carries
   the issue path, per-request freshness by re-reading a changed fake file).

## Out of scope
Any write path (053), running agents (054), pointer moves (055), per-tenant agent registries
(shared file only — per-tenant registries become a backlog note), styling beyond the console's
existing plain tables.

## Acceptance criteria
- [ ] `/agents` lists every alias with per-env pointers and `/agents/[name]` shows full version
      history — rendered from a fresh per-request read of `AGENTS_CONFIG`.
- [ ] A malformed or missing agents file renders a legible error state naming the problem; it
      never renders an empty catalog.
- [ ] Viewmodels are pure and unit-tested, including orphan (alias-less) versions.
- [ ] Compose and Helm mount the agents file into the console; helm render drill stays green.
- [ ] `pnpm test` and `pnpm build` green.
