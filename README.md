# Agentic Platform

Enterprise agentic platform: durable AI-agent runs, governed tool execution, full audit,
deployable inside client networks. See `docs/architecture.md` (what) and `docs/build-plan.md`
(in what order, with what proof).

**New here? Start with [GETTING-STARTED.md](GETTING-STARTED.md)** — boot the
platform with Docker, create an agent in the browser, run it, approve its
first governed write, and read the audit trail. ~15 minutes, no code.

## Quickstart

```sh
pnpm install   # install all workspaces
pnpm build     # tsc --build with project references
pnpm test      # vitest across all packages
```

Node ≥20 and pnpm ≥9 required. Copy `.env.example` to `.env` for local infra
(`deploy/docker-compose.yml` brings up Postgres + self-hosted Temporal).

## Layout

```
docs/                    architecture + phased build plan (source of truth)
tickets/                 numbered work tickets + BACKLOG.md
packages/core            run event model + reducer (pure, no I/O)
packages/storage         event-log storage contract + adapters
packages/model-gateway   provider abstraction, allowlist, failover, metering
apps/worker              Temporal worker (durable agent runs)
deploy/                  client-site compose profile (later: Helm)
```

## How work happens

Work `tickets/` **in numeric order**, one ticket at a time; each ticket's checkbox
acceptance criteria are the definition of done. Conventions and non-negotiable rules
live in `CLAUDE.md`. When tickets run out, expand `tickets/BACKLOG.md` into the next
numbered batch before writing code.
