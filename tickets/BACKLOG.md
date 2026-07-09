# Backlog — next batches (expand into numbered tickets when 001–005 are done)

## Batch 006–010 (completes Phase 1)
- **006 — Postgres EventStore adapter.** Runs ticket 002's conformance suite unchanged; append is one
  transaction with optimistic concurrency (unique (run_id, seq)); forward-only SQL migrations; connection
  config via env. In-memory store remains the default for unit tests.
- **007 — Anthropic provider.** Real `ModelProvider` behind 004's interface (API key via env, timeouts,
  bounded retries); FakeProvider stays the default in all tests; a secrets-scan test proves no key material
  in logs/events (CLAUDE.md rule 4).
- **008 — OTel tracing.** One trace per run, spans per step from engine + gateway (GenAI semantic
  conventions: tokens, cost, model, tool); exporter configurable; no-op exporter in tests.
- **009 — Run viewer.** `apps/console` (Next.js): runs table + per-run step timeline with tokens/cost,
  read-only, served against the EventStore. Deliberately boring; truthful over beautiful.
- **010 — Thin schedules.** Recurring runs for read-only agents via Temporal Schedules: timezone-pinned,
  skip-if-running overlap, explicit catch-up policy (build-plan Phase 1, exit drill 6).

## Then: Phase 1 exit
Enable worker/console images in `deploy/docker-compose.yml`; pass the artifact test (exit drill 7);
run all Phase 1 exit drills as recorded tests/scripts. Only then open Phase 2 (tool gateway, policy,
approvals, identity delegation, trigger subsystem) per `docs/build-plan.md`.
