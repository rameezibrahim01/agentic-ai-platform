import { describe, expect, it } from "vitest";
import { trace as otelTrace, TraceFlags } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { replay, type RunEvent } from "@platform/core";
import { emitRunTrace, GENAI_ATTR, PLATFORM_ATTR } from "@platform/telemetry";

function makeTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { tracer: provider.getTracer("test"), exporter };
}

/** Completed run: 2 tool steps, then a final message call. */
function completedRun(): RunEvent[] {
  const runId = "run-t";
  const events: RunEvent[] = [
    { type: "RunStarted", runId, seq: 0, at: 1000, agent: "a@v1", principal: "user:x", input: {} },
  ];
  let seq = 1;
  let at = 1100;
  for (const step of [0, 1]) {
    events.push(
      { type: "ModelCalled", runId, seq: seq++, at: (at += 10), gatewayReqId: `g${step}`, model: "m1", tokensIn: 100 + step, tokensOut: 40 + step, costUsd: 0.5 },
      { type: "ToolIntentEmitted", runId, seq: seq++, at: (at += 10), tool: "crm.lookup", args: { step }, risk: "read" },
      { type: "PolicyEvaluated", runId, seq: seq++, at: (at += 10), decision: "allow", rule: "r" },
      { type: "ToolExecuted", runId, seq: seq++, at: (at += 10), gatewayReqId: `g${step}`, resultDigest: "d", latencyMs: 5 },
    );
  }
  events.push(
    { type: "ModelCalled", runId, seq: seq++, at: (at += 10), gatewayReqId: "gf", model: "m1", tokensIn: 50, tokensOut: 10, costUsd: 0.25 },
    { type: "RunCompleted", runId, seq: seq++, at: (at += 10), outcome: "done", totalCostUsd: 1.25, steps: 3 },
  );
  return events;
}

function budgetFailedRun(): RunEvent[] {
  const runId = "run-b";
  return [
    { type: "RunStarted", runId, seq: 0, at: 1000, agent: "a@v1", principal: "user:x", input: {} },
    { type: "ModelCalled", runId, seq: 1, at: 1010, gatewayReqId: "g", model: "m1", tokensIn: 10, tokensOut: 5, costUsd: 9.99 },
    { type: "BudgetExceeded", runId, seq: 2, at: 1020, reason: "MaxCostUsd", detail: "over" },
    { type: "RunFailed", runId, seq: 3, at: 1030, reason: "MaxCostUsd" },
  ];
}

describe("emitRunTrace (ticket 008)", () => {
  it("one root span per run with correctly parented child spans per step", () => {
    const { tracer, exporter } = makeTracer();
    const events = completedRun();
    const result = emitRunTrace(tracer, events);
    expect(result).toEqual({ ok: true, spans: 6 }); // root + 3 model + 2 tool

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(6);
    const root = spans.find((s) => s.name.startsWith("agent.run"))!;
    expect(root).toBeDefined();
    const children = spans.filter((s) => s !== root);
    for (const child of children) {
      expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    }
    expect(children.filter((s) => s.name.startsWith("model.call"))).toHaveLength(3);
    expect(children.filter((s) => s.name.startsWith("tool.execute"))).toHaveLength(2);
  });

  it("attributes exactly match the event log's totals — single source of truth", () => {
    const { tracer, exporter } = makeTracer();
    const events = completedRun();
    emitRunTrace(tracer, events);
    const replayed = replay(events);
    if (!replayed.ok) throw new Error("fixture invalid");
    const { state } = replayed;

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name.startsWith("agent.run"))!;
    expect(root.attributes[PLATFORM_ATTR.costUsd]).toBe(state.costUsd);
    expect(root.attributes[GENAI_ATTR.inputTokens]).toBe(state.tokensIn);
    expect(root.attributes[GENAI_ATTR.outputTokens]).toBe(state.tokensOut);
    expect(root.attributes[PLATFORM_ATTR.steps]).toBe(state.stepCount);
    expect(root.attributes[PLATFORM_ATTR.outcome]).toBe("completed");

    const modelSpans = spans.filter((s) => s.name.startsWith("model.call"));
    const spanCost = modelSpans.reduce((t, s) => t + Number(s.attributes[PLATFORM_ATTR.costUsd]), 0);
    const spanTokensIn = modelSpans.reduce((t, s) => t + Number(s.attributes[GENAI_ATTR.inputTokens]), 0);
    expect(spanCost).toBe(state.costUsd);
    expect(spanTokensIn).toBe(state.tokensIn);
    for (const s of modelSpans) {
      expect(s.attributes[GENAI_ATTR.requestModel]).toBe("m1");
    }
    const toolSpans = spans.filter((s) => s.name.startsWith("tool.execute"));
    for (const s of toolSpans) {
      expect(s.attributes[PLATFORM_ATTR.tool]).toBe("crm.lookup");
    }
  });

  it("a budget-terminated run marks the root span with the failure outcome and reason", () => {
    const { tracer, exporter } = makeTracer();
    emitRunTrace(tracer, budgetFailedRun());
    const root = exporter.getFinishedSpans().find((s) => s.name.startsWith("agent.run"))!;
    expect(root.attributes[PLATFORM_ATTR.outcome]).toBe("failed");
    expect(root.attributes[PLATFORM_ATTR.failureReason]).toBe("MaxCostUsd");
    expect(root.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("with no SDK registered everything is a no-op: no spans, no errors", () => {
    // tracer from the bare API — no provider registered anywhere
    const tracer = otelTrace.getTracer("noop-test");
    const result = emitRunTrace(tracer, completedRun());
    expect(result).toEqual({ ok: true, spans: 6 });
    // the API's no-op tracer produces non-recording spans
    const span = tracer.startSpan("probe");
    expect(span.isRecording()).toBe(false);
    expect(span.spanContext().traceFlags).toBe(TraceFlags.NONE);
    span.end();
  });

  it("an unreplayable log is a typed failure, not a crash", () => {
    const { tracer, exporter } = makeTracer();
    const [first] = completedRun();
    const result = emitRunTrace(tracer, [
      first!,
      { type: "RunFailed", runId: "run-t", seq: 5, at: 2, reason: "gap" },
    ]);
    expect(result.ok).toBe(false);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
