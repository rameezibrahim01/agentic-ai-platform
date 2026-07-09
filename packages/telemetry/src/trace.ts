import { context as otelContext, SpanStatusCode, trace as otelTrace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import { replay } from "@platform/core";
import type { ReplayRejection, RunEvent } from "@platform/core";

// The trace is DERIVED from the event log — the log is the source of truth
// (CLAUDE.md #5), so span attributes cannot disagree with the audit record.
// One trace per run, spans per step (build-plan Phase 1 workstream (c)).
// With no SDK/provider registered, every call below is a safe no-op — that is
// the @opentelemetry/api contract, and this package depends on nothing else.

/** GenAI semantic-convention attribute names. */
export const GENAI_ATTR = {
  requestModel: "gen_ai.request.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
} as const;

/** Platform attribute names. */
export const PLATFORM_ATTR = {
  runId: "platform.run_id",
  agent: "platform.agent",
  principal: "platform.principal",
  costUsd: "platform.cost_usd",
  tool: "platform.tool",
  eventSeq: "platform.event_seq",
  outcome: "platform.outcome",
  failureReason: "platform.failure_reason",
  steps: "platform.steps",
} as const;

export type EmitRunTraceResult =
  | { ok: true; spans: number }
  | { ok: false; reason: ReplayRejection };

/**
 * Emit one complete trace for a run from its event log: a root span covering
 * the run, a child span per model call, and a child span per tool execution.
 * Span timestamps come from event `at` values (epoch ms UTC), not the clock.
 */
export function emitRunTrace(tracer: Tracer, events: readonly RunEvent[]): EmitRunTraceResult {
  const replayed = replay(events);
  if (!replayed.ok) return { ok: false, reason: replayed.reason };
  const { state } = replayed;

  const first = events[0]!;
  const last = events[events.length - 1]!;
  if (first.type !== "RunStarted") return { ok: false, reason: { code: "empty_log" } };

  const root = tracer.startSpan(
    `agent.run ${state.runId}`,
    {
      startTime: first.at,
      attributes: {
        [PLATFORM_ATTR.runId]: state.runId,
        [PLATFORM_ATTR.agent]: state.agent,
        [PLATFORM_ATTR.principal]: state.principal,
        [PLATFORM_ATTR.costUsd]: state.costUsd,
        [PLATFORM_ATTR.steps]: state.stepCount,
        [GENAI_ATTR.inputTokens]: state.tokensIn,
        [GENAI_ATTR.outputTokens]: state.tokensOut,
        [PLATFORM_ATTR.outcome]: state.outcome?.kind ?? state.status,
        ...(state.outcome?.kind === "failed"
          ? { [PLATFORM_ATTR.failureReason]: state.outcome.reason }
          : {}),
      },
    },
  );
  const runContext = otelTrace.setSpan(otelContext.active(), root);

  let spans = 1;
  let pendingTool: { tool: string; startedAt: number; seq: number } | null = null;
  for (const event of events) {
    switch (event.type) {
      case "ModelCalled": {
        const span = tracer.startSpan(
          `model.call ${event.model}`,
          {
            startTime: event.at,
            attributes: {
              [GENAI_ATTR.requestModel]: event.model,
              [GENAI_ATTR.inputTokens]: event.tokensIn,
              [GENAI_ATTR.outputTokens]: event.tokensOut,
              [PLATFORM_ATTR.costUsd]: event.costUsd,
              [PLATFORM_ATTR.eventSeq]: event.seq,
              [PLATFORM_ATTR.runId]: event.runId,
            },
          },
          runContext,
        );
        span.end(event.at);
        spans += 1;
        break;
      }
      case "ToolIntentEmitted": {
        pendingTool = { tool: event.tool, startedAt: event.at, seq: event.seq };
        break;
      }
      case "ToolExecuted":
      case "ToolFailed": {
        const tool = pendingTool?.tool ?? "unknown";
        const span = tracer.startSpan(
          `tool.execute ${tool}`,
          {
            startTime: pendingTool?.startedAt ?? event.at,
            attributes: {
              [PLATFORM_ATTR.tool]: tool,
              [PLATFORM_ATTR.eventSeq]: event.seq,
              [PLATFORM_ATTR.runId]: event.runId,
            },
          },
          runContext,
        );
        if (event.type === "ToolFailed") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
        }
        span.end(event.at);
        spans += 1;
        pendingTool = null;
        break;
      }
      default:
        break;
    }
  }

  if (state.status === "failed") {
    root.setStatus({
      code: SpanStatusCode.ERROR,
      message: state.outcome?.kind === "failed" ? state.outcome.reason : "failed",
    });
  } else {
    root.setStatus({ code: SpanStatusCode.OK });
  }
  root.end(last.at);
  return { ok: true, spans };
}
