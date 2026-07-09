# 011 — Worker/console images + compose artifact test

**Packages:** `apps/worker`, `apps/console`, `deploy/` · **Depends on:** 003–010 · **Allowed deps (add in this ticket):** `tsx` (worker runtime), Docker/compose tooling (build-time only)

## Context
Build-plan Phase 1 exit drill 7: the entire Phase 1 system installs on a clean machine from the release artifact — Postgres, Temporal, worker, console — with no network beyond the model endpoint (CLAUDE.md #8). The compose profile has shipped since ticket 000 with the app services commented out; this ticket turns them on and proves the boot, executable and recorded.

## Scope
1. **Worker image** (`apps/worker/Dockerfile`): multi-stage pnpm workspace build, runs `src/worker.ts` via `tsx`; worker selects its store from env — `DATABASE_URL` set → Postgres adapter **and runs migrations on boot** (the worker owns migrations), else in-memory. `TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE` from env as already wired.
2. **Console image** (`apps/console/Dockerfile`): `next build` with `output: "standalone"`, minimal runtime stage.
3. **Compose enablement** (`deploy/docker-compose.yml`): worker + console services uncommented with healthchecks/depends_on ordering (postgres → temporal → worker → console), `DATABASE_URL` pointed at the bundled Postgres. Everything inside the network; the only permitted egress remains the model endpoint (unused by the stub provider).
4. **The artifact smoke script** (`scripts/artifact-smoke.sh`): builds images, boots the profile, waits for and asserts — worker reaches RUNNING against self-hosted Temporal, migrations applied, console serves `/runs` (HTTP 200) against Postgres, Temporal UI answers — then tears down. This script IS exit drill 7's executable form.
5. **CI job `artifact`** running the smoke script on every PR (GitHub runners have Docker; the sandbox does not — CI is the authoritative run, consistent with 003/006).

## Out of scope
Helm charts, image registries/versioned publishing, air-gap profile docs, resource limits, the remaining exit drills (012).

## Acceptance criteria
- [ ] `docker compose up` from a clean checkout brings up postgres, temporal, temporal-ui, worker, and console — no service crash-loops.
- [ ] Worker connects to the bundled Temporal (RUNNING) and applies migrations on boot; console serves `/runs` with HTTP 200 against the bundled Postgres.
- [ ] `scripts/artifact-smoke.sh` performs the full boot-assert-teardown cycle and exits 0; CI job `artifact` runs it and is green.
- [ ] No runtime dependency outside the compose network is required for the boot (CLAUDE.md #8).
- [ ] `pnpm test` and `pnpm build` remain green.
