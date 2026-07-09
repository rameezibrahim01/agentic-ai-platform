import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { InMemoryEventStore } from "@platform/storage";
import { createGateway, FakeProvider, fakeIntent, fakeMessage } from "@platform/model-gateway";
import { createActivities } from "../src/activities.js";

// Activities are plain async functions — the engine+gateway tracing path is
// testable without Temporal. The durable-execution path is covered in
// workflow.test.ts; span emission is identical (same terminal activities).

function makeWorld() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const store = new InMemoryEventStore();
  const gateway = createGateway({
    env: "test",
    allowlist: ["fake-model"],
    pricing: { "fake-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    providers: [
      {
        name: "fake",
        provider: new FakeProvider([
          { kind: "respond", result: fakeIntent({ tool: "crm.lookup", args: { q: 1 } }) },
          { kind: "respond", result: fakeMessage("done") },
        ]),
      },
    ],
  });
  const activities = createActivities({ store, gateway, tracer: provider.getTracer("worker-test") });
  return { exporter, store, activities };
}

describe("worker trace emission (ticket 008)", () => {
  it("a completed run emits one correctly shaped trace at the terminal activity", async () => {
    const { exporter, activities } = makeWorld();
    const runId = "run-traced";
    let { version } = await activities.startRun({ runId, agent: "a@v1", principal: "u", input: {} });
    const model1 = await activities.callModel({ runId, expectedVersion: version, model: "fake-model", prompt: "p" });
    if (model1.kind !== "tool_intent") throw new Error("scripted intent expected");
    version = (await activities.executeTool({ runId, expectedVersion: model1.version, tool: model1.tool, args: model1.args, risk: model1.risk })).version;
    const model2 = await activities.callModel({ runId, expectedVersion: version, model: "fake-model", prompt: "p" });
    if (model2.kind !== "message") throw new Error("scripted message expected");
    await activities.completeRun({ runId, expectedVersion: model2.version, outcome: model2.content, totalCostUsd: 0.1, steps: 2 });

    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => s.name.startsWith("agent.run"))).toHaveLength(1);
    expect(spans.filter((s) => s.name.startsWith("model.call"))).toHaveLength(2);
    expect(spans.filter((s) => s.name.startsWith("tool.execute"))).toHaveLength(1);

    // a redelivered terminal activity dedupes and must NOT re-emit the trace
    await activities.completeRun({ runId, expectedVersion: model2.version, outcome: model2.content, totalCostUsd: 0.1, steps: 2 });
    expect(exporter.getFinishedSpans().filter((s) => s.name.startsWith("agent.run"))).toHaveLength(1);
  });

  it("a budget-terminated run emits an errored root span with the reason", async () => {
    const { exporter, activities } = makeWorld();
    const runId = "run-traced-fail";
    const { version } = await activities.startRun({ runId, agent: "a@v1", principal: "u", input: {} });
    await activities.recordBudgetFailure({ runId, expectedVersion: version, reason: "LoopDetected", detail: "x3" });

    const root = exporter.getFinishedSpans().find((s) => s.name.startsWith("agent.run"))!;
    expect(root).toBeDefined();
    expect(root.attributes["platform.outcome"]).toBe("failed");
    expect(root.attributes["platform.failure_reason"]).toBe("LoopDetected");
    expect(root.status.code).toBe(2); // ERROR
  });

  it("without a tracer, nothing is emitted and nothing breaks", async () => {
    const store = new InMemoryEventStore();
    const gateway = createGateway({
      env: "test",
      allowlist: ["fake-model"],
      pricing: { "fake-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      providers: [{ name: "fake", provider: new FakeProvider([{ kind: "respond", result: fakeMessage("done") }]) }],
    });
    const activities = createActivities({ store, gateway }); // no tracer
    const runId = "run-untraced";
    const { version } = await activities.startRun({ runId, agent: "a@v1", principal: "u", input: {} });
    const model = await activities.callModel({ runId, expectedVersion: version, model: "fake-model", prompt: "p" });
    if (model.kind !== "message") throw new Error("scripted message expected");
    const done = await activities.completeRun({ runId, expectedVersion: model.version, outcome: model.content, totalCostUsd: 0, steps: 1 });
    expect(done.version).toBe(3);
  });
});
