# 053 — Agent builder: create a version from the browser

**Packages:** `apps/console`, `packages/auth`, `deploy/` · **Depends on:** 047, 052 · **Allowed deps:** none new

## Context
Today a new agent is a JSON edit and a redeploy — invisible to the people the architecture says
should own agents ("an agent here is not code — it is a versioned configuration object", §3).
This ticket makes the console able to CREATE agent versions: a form (name, description, prompt,
model, tools, budgets) whose submit appends an immutable `name@vN` to `agents.config.json`.
The write path is 047's, verbatim in spirit: validate the current file, refuse to touch a
malformed one, round-trip-validate the proposed next content, rename-with-in-place-fallback,
and record the action (or its refusal) in `ops_audit`. Immutability survives the new writer:
the builder can only APPEND versions — it never edits or deletes a published one, so 028's
digest discipline and one-command rollback keep their meaning.

## Scope
1. `packages/auth` roles: a new action `author_agents` → `["agent_developer", "platform_admin"]`
   — the `agent_developer` role gets its first teeth. Deny-by-default table extended, tested.
2. Pure core in `apps/console/src/lib/agents.ts`: `draftVersion(config, draft)` →
   `{ ok, config: next, id }` — picks the next free `@vN` for the name, appends the version,
   and for a brand-new name creates the alias with the `dev` pointer at the new version
   (prod pointers move only via 055/promote). Refuses: invalid draft (zod, `.strict()`),
   id collisions, and any diff to an existing version (append-only asserted structurally:
   every prior version must be byte-identical in the next config). `handleAgentCreate(deps, …)`
   composes session-gate → read → draft → validate-next → write → audit, pure over injected
   deps like `handleSwitchFlip`.
3. Form sources, read-only: model options from `MODELS_CONFIG`'s allowlist when mounted (else
   `stub-model`); tool checkboxes from the console's ro `TOOLS_CONFIG` mount (registry tools +
   MCP-config tools, each labeled with its risk). The form warns — copy only, no enforcement —
   that tools also need a grant in the deployment's tools config before intents pass the gateway.
4. `/agents/new` page + `POST /api/agents` route; `/agents/[name]` gains a "new version" form
   pre-filled from the newest version. Server-side re-validation of everything (the form is
   convenience, zod is the contract). Gated by `author_agents`; refusals audited.
5. `deploy/docker-compose.yml`: console's agents mount flips ro→rw (the 047 precedent —
   the worker never writes it, run starters only read it); console gets ro `TOOLS_CONFIG` and
   optional `MODELS_CONFIG`. Helm: same, `values.schema.json` extended, render drill green.
6. Tests: append-only property (fast-check: any accepted draft leaves all prior versions
   byte-identical), collision/malformed refusals audited, next-`@vN` numbering, new-name alias
   gets dev pointer only, role gate (viewer refused + audited), round-trip through the real
   `agentsConfigSchema` copy.

## Out of scope
Editing/deleting versions (immutable, forever), prod pointer moves (055), per-tenant agent
files, granting tools from the console (grants stay deployment config), prompt templating.

## Acceptance criteria
- [ ] A signed-in `agent_developer` can create `name@v1` (new alias, dev pointer) and
      `name@vN+1` (existing name) entirely from the browser; the file round-trips through the
      schema and the worker's own `loadAgentsConfig` accepts it (asserted in a test).
- [ ] The builder can never mutate a published version — structurally asserted append-only,
      property-tested; a malformed current file refuses the write with a legible error.
- [ ] Every create — and every refusal — lands in `ops_audit` with actor, name@version, outcome.
- [ ] Model/tool pickers are populated from the mounted configs; a missing mount degrades to
      the documented defaults, never a crash.
- [ ] Compose + Helm wiring updated; helm render drill green; `pnpm test`/`pnpm build` green.
