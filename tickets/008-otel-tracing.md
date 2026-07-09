# 008 — OTel tracing

**Packages:** new `packages/telemetry` + wiring in `apps/worker` · **Depends on:** 003, 004, 005 · **Allowed deps (add in this ticket):** `@opentelemetry/api` (telemetry pkg); `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/resources` (worker + dev/test)

## Context
Build-plan Phase 1 workstream (c): one trace per run, spans per step, attributes for tokens/cost/model/tool — flowing to whatever OTel backend the client runs (CLAUDE.md #8: traces leave over OTel, no SaaS-only backend). Tests use an in-memory exporter; production wiring is configurable and defaults to no-op.

## Scope
1. `packages/telemetry` (`@platform/telemetry`), depending only on `@opentelemetry/api`:
   - `RunTracer` helper: `startRunSpan(runId, agent, principal)` → one root span per run; `stepSpan(kind, attrs)` children per step;
   - GenAI semantic-convention attribute names (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) plus platform attributes (`platform.run_id`, `platform.cost_usd`, `platform.tool`, `platform.event_seq`, `platform.outcome`);
   - no-op by default: with no SDK registered, all calls are safe no-ops (OTel api guarantees this) — packages never configure exporters.
2. Worker wiring: activities emit spans around model calls (model, tokens, cost from the gateway result) and tool executions (tool name, seq); the run span carries final outcome and totals. Exporter setup lives in `apps/worker` only (`initTracing({ exporter })`), configurable, defaulting to none.
3. Tests: `InMemorySpanExporter` asserts the shape — one root span per run, correct parentage, attribute values matching the event log's tokens/cost exactly.

## Out of scope
Metrics, logs, ClickHouse/Langfuse setup, sampling policy, context propagation across services, console UI for traces.

## Acceptance criteria
- [ ] With the in-memory exporter: a completed scripted run yields exactly one root run-span with child spans per model call and per tool execution, correctly parented.
- [ ] Span attributes carry model, input/output tokens, and cost that **exactly match** the run's event log totals (single source: gateway metering).
- [ ] A budget-terminated run marks the run span with the failure outcome and reason.
- [ ] With no exporter configured, everything is a no-op: zero spans, zero errors, tests still green (proves packages stay pure).
- [ ] `pnpm test` and `pnpm build` green across the workspace.
