# 059 — Agent templates: start from a job, not a blank prompt

**Packages:** `apps/console` · **Depends on:** 053, 057, 058 · **Allowed deps:** none new

## Context
The builder (053) proved a person can create an agent — and also that a blank form asks a
department user to invent a prompt, pick tools, and guess budgets from nothing. Templates fix
the cold start: a small, curated set of pre-filled drafts for the jobs the connectors (057/058)
just made possible. A template is ONLY a pre-filled form — saving still mints a normal
immutable version through the 053 write path, grants still come from deployment config, and
nothing about governance changes. The templates ship in-repo (curated, reviewed prompts), not
as runtime config: a template is a recommendation, and recommendations get code review.

## Scope
1. `apps/console/src/lib/templates.ts`: a typed, static list — each entry `{id, title, blurb,
   draft}` where `draft` satisfies the builder's `agentDraftSchema` minus `name` (the user
   names their copy). Ship three, written for real use:
   - **invoice-checker** — reads the documents folder, cross-checks CSV invoices, appends a
     findings row (`docs.list/docs.read/sheet.read` + `sheet.append`).
   - **mailbox-triage** — searches the inbox, reads flagged mail, drafts a reply for approval
     (`mail.search/mail.read` + `mail.send`).
   - **note-taker** — the walkthrough classic (`notes.append`) so the template path works on a
     deployment with no connectors configured.
2. `/agents/new?template=<id>` pre-fills the form (same mechanism as `?from=`); `/agents/new`
   and `/agents` show the template picker (title + blurb + "use this template").
3. Availability honesty: a template tool missing from this deployment's `TOOLS_CONFIG` renders
   unchecked and disabled with "not configured on this deployment — see DEPLOYMENT.md", and
   the picker card says which connectors the template needs. No silent half-templates.
4. Tests: every shipped template's draft passes `agentDraftSchema` AND round-trips through
   `draftVersion` + the worker's `loadAgentsConfig`; the unavailable-tool partition is a pure
   function with its own tests; unknown `?template=` falls back to the blank form, never a
   crash.

## Out of scope
User-defined/saved templates, a template marketplace, per-tenant template sets, localizing
template prompts (Arabic lands with the government batch if that path is chosen).

## Acceptance criteria
- [ ] Three templates render as picker cards; choosing one pre-fills the builder; saving mints
      a normal immutable version via the existing 053 path (no new write machinery).
- [ ] Templates needing unconfigured connectors say so on the card and disable those tools in
      the form — tested via the pure partition function.
- [ ] Every shipped template draft is schema-valid and worker-loadable (asserted in tests).
- [ ] `pnpm test` and `pnpm build` green.
