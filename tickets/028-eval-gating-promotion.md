# 028 — Eval gating in CI + promotion pointers with one-command rollback

**Packages:** `apps/worker` (version resolution), `scripts/`, `.github/workflows/`, `deploy/` · **Depends on:** 027 · **Allowed deps:** none new

## Context
Build-plan Phase 3(b)+(c): any change to an agent's prompt, config, or model runs its suite, and red blocks promotion exactly like a failing test. Versions are immutable (027); what moves is a **pointer per environment**. Promotion is editing the pointer through a gate; rollback is flipping it back — one command, no rebuild, because the old version never stopped existing.

## Scope
1. `deploy/agents.config.json` (zod-validated): the registry of `AgentVersionSpec`s plus per-environment pointers `{ aliases: { "triage": { dev: "triage@v2", prod: "triage@v1" } } }`. The worker resolves an alias to its pinned version for the current `PLATFORM_ENV` at run start (`resolveAgentAlias`); direct `name@vN` references keep working unchanged.
2. **Immutability enforced, not assumed**: a vitest suite snapshots the content digest of every agent version present on `main` (committed digest file); changing a published version's spec without minting a new `@vN+1` fails the suite with the digest diff. New versions append.
3. `scripts/evals/run-evals.sh`: run every agent's suite via the 027 harness (pass-count discipline from `lib.sh`); prints per-scenario verdicts; nonzero on any red.
4. CI: an `evals` job on every PR — prompt/config/model changes cannot merge red. (Tickets are the spec: the gate runs on every PR, not just agent-file diffs — cheap, and immune to path-filter blind spots.)
5. `scripts/promote.sh <alias> <version> <env>`: refuses unless the target version's suite passes NOW (runs it), then rewrites the pointer in `agents.config.json`. `scripts/rollback.sh <alias> <env>` flips the pointer to the previously recorded version (kept in the config as `previous`), **without** re-running evals — rollback must never be gated.
6. Drill (recorded in `docs/drills/phase-3.md`, started here): the bad-prompt test — a deliberately degraded copy of an agent version fails its suite in CI form with a legible diff of which scenarios failed and why.

## Out of scope
Canary/traffic-slicing (manual promotion + fast rollback is the honest baseline at this volume — per build-plan's "safe to cut"), promotion UI, multi-cluster pointer sync.

## Acceptance criteria
- [ ] Worker resolves aliases per environment from `agents.config.json`; direct versions unchanged.
- [ ] Published-version immutability is CI-enforced via content digests (mutating a version fails; appending v2 passes).
- [ ] `promote.sh` is gated on a green suite run; `rollback.sh` is one command, ungated, and restores the previous pointer.
- [ ] CI `evals` job red-blocks; the bad-prompt drill produces a legible scenario diff (recorded in `docs/drills/phase-3.md`).
- [ ] `pnpm test` and `pnpm build` green.
