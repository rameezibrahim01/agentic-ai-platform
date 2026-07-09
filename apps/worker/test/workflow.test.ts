import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { replay, type RunEventType } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import {
  createGateway,
  FakeProvider,
  fakeIntent,
  fakeMessage,
  type FakeBehavior,
  type Usage,
} from "@platform/model-gateway";
import { createActivities, type Activities } from "../src/activities.js";
import { startAgentRun } from "../src/client.js";
import { WORKER_READY } from "../src/index.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));

// Local Temporal test server — no external cluster. The SDK downloads an
// ephemeral dev server from temporal.download on first use (CI does this), or
// set TEMPORAL_CLI_PATH to an existing `temporal` binary. In sandboxes whose
// egress policy blocks the download, the suite SKIPS with a warning — but only
// outside CI: in CI a download failure is a hard failure, never a silent skip.
let env: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  const cliPath = process.env["TEMPORAL_CLI_PATH"];
  try {
    env = await TestWorkflowEnvironment.createLocal(
      cliPath
        ? { server: { executable: { type: "existing-path", path: cliPath } } }
        : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const downloadBlocked = /Failed to start ephemeral server.*temporal\.download/s.test(message);
    if (downloadBlocked && !process.env["CI"]) {
      console.warn(
        `[workflow.test] SKIPPING Temporal suite: ephemeral server download blocked ` +
          `by this environment's egress policy (temporal.download). ` +
          `CI runs this suite for real; or set TEMPORAL_CLI_PATH. Cause: ${message}`,
      );
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

const USAGE: Usage = { tokensIn: 100, tokensOut: 20 };
const PRICING = { "fake-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } };

/** Store + gateway + activities for one test, from a FakeProvider script. */
function makeDeps(script: FakeBehavior[]) {
  const store = new InMemoryEventStore();
  const gateway = createGateway({
    env: "test",
    allowlist: ["fake-model"],
    pricing: PRICING,
    providers: [{ name: "fake", provider: new FakeProvider(script) }],
  });
  return { store, activities: createActivities({ store, gateway }) };
}

const runInput = (runId: string) => ({
  runId,
  agent: "stub-agent@v1",
  principal: "user:test",
  input: { q: 1 },
  model: "fake-model",
  prompt: "scripted",
});

/** Completed run with `steps` tool steps: RunStarted, 4 events per step, final ModelCalled, RunCompleted. */
function expectedCompletedTypes(steps: number): RunEventType[] {
  const types: RunEventType[] = ["RunStarted"];
  for (let i = 0; i < steps; i++) {
    types.push("ModelCalled", "ToolIntentEmitted", "PolicyEvaluated", "ToolExecuted");
  }
  types.push("ModelCalled", "RunCompleted");
  return types;
}

async function loadReplayed(store: InMemoryEventStore, runId: string) {
  const loaded = await store.load(runId);
  expect(loaded).not.toBeNull();
  // zero duplicated events: strictly contiguous seq starting at 0
  expect(loaded!.events.map((e) => e.seq)).toEqual([...loaded!.events.keys()]);
  const replayed = replay(loaded!.events);
  expect(replayed.ok).toBe(true);
  if (!replayed.ok) throw new Error("unreachable");
  return { events: loaded!.events, state: replayed.state };
}

describe("agentRun workflow (tickets 003 + 005)", () => {
  it(
    "kill test: worker dies mid-run; a fresh worker completes it with zero duplicated events",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-kill";
      const taskQueue = "tq-kill-test";
      const { store, activities: real } = makeDeps([
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { step: 0 } }, USAGE) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { step: 1 } }, USAGE) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { step: 2 } }, USAGE) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { step: 3 } }, USAGE) },
        { kind: "respond", result: fakeMessage("all done", USAGE) },
      ]);

      // Worker 1 executes steps 0–1 (log version 9), then starts failing —
      // simulating a worker that dies between two activities mid-run.
      let worker1Refusals = 0;
      const activities1: Activities = {
        ...real,
        async callModel(request) {
          if (request.expectedVersion >= 9) {
            worker1Refusals += 1;
            throw new Error("injected: worker1 dying");
          }
          return real.callModel(request);
        },
      };
      const worker1 = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities: activities1,
      });
      const worker1Run = worker1.run();
      const handle = await startAgentRun(env.client, runInput(runId), { taskQueue });

      // Wait until worker1 has demonstrably progressed into the run and hit the wall.
      while (worker1Refusals === 0) {
        await sleep(25);
      }
      worker1.shutdown();
      await worker1Run;
      expect((await store.load(runId))!.version).toBe(9); // steps 0–1 landed, run unfinished

      // Fresh worker picks the run up from Temporal history and finishes it.
      let worker2ModelCalls = 0;
      const activities2: Activities = {
        ...real,
        async callModel(request) {
          worker2ModelCalls += 1;
          return real.callModel(request);
        },
      };
      const worker2 = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities: activities2,
      });
      const result = await worker2.runUntil(handle.result());

      expect(result).toEqual({ outcome: "completed", version: 19, steps: 5 });
      expect(worker2ModelCalls).toBeGreaterThan(0); // worker2 did real work
      const { events, state } = await loadReplayed(store, runId);
      expect(events.map((e) => e.type)).toEqual(expectedCompletedTypes(4));
      expect(state.status).toBe("completed");
      expect(state.stepCount).toBe(5);
    },
    120_000,
  );

  it(
    "retry test: an activity that fails after appending yields exactly one appended event set",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-retry";
      const taskQueue = "tq-retry-test";
      const { store, activities: real } = makeDeps([
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { q: 1 } }, USAGE) },
        { kind: "respond", result: fakeMessage("done", USAGE) },
      ]);

      let executeToolAttempts = 0;
      const activities: Activities = {
        ...real,
        async executeTool(request) {
          executeToolAttempts += 1;
          const response = await real.executeTool(request); // append succeeds…
          if (executeToolAttempts === 1) {
            throw new Error("injected: crash after successful append"); // …then the worker dies
          }
          return response;
        },
      };
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(env!.client, runInput(runId), { taskQueue });
        return handle.result();
      });

      expect(executeToolAttempts).toBe(2); // retried…
      expect(result.outcome).toBe("completed");
      const { events } = await loadReplayed(store, runId); // …but appended exactly once
      expect(events.map((e) => e.type)).toEqual(expectedCompletedTypes(1));
    },
    120_000,
  );

  it(
    "adversarial loop: a provider scripted to loop forever is terminated by loop detection",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-loop";
      const taskQueue = "tq-loop-test";
      // Last script item repeats forever: the model "wants" this intent eternally.
      // Near-identical args (key order, whitespace) must still be caught.
      const { store, activities } = makeDeps([
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { q: "acme", limit: 10 } }, USAGE) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { limit: 10, q: " acme " } }, USAGE) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { q: "acme", limit: 10.0000001 } }, USAGE) },
      ]);
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(env!.client, runInput(runId), { taskQueue });
        return handle.result();
      });

      // terminated within ≤ N+1 identical intents (N = 3): 3 model calls, run failed
      expect(result).toEqual({ outcome: "budget_exceeded", reason: "LoopDetected", version: 12, steps: 3 });
      const { events, state } = await loadReplayed(store, runId);
      expect(events.filter((e) => e.type === "ModelCalled")).toHaveLength(3);
      // BudgetExceeded then RunFailed(LoopDetected), and nothing after
      expect(events.at(-2)?.type).toBe("BudgetExceeded");
      expect(events.at(-1)).toMatchObject({ type: "RunFailed", reason: "LoopDetected" });
      expect(state.status).toBe("failed");
      expect(state.outcome).toEqual({ kind: "failed", reason: "LoopDetected" });
    },
    120_000,
  );

  it(
    "cost cap: expensive usage trips maxCostUsd at the correct step; nothing after RunFailed",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-costcap";
      const taskQueue = "tq-costcap-test";
      // 1M input tokens at $3/MTok = $3.00 per call… wait, keep it simple:
      // usage priced to exactly $1.00 per call via tokensIn.
      const expensive: Usage = { tokensIn: 333_000, tokensOut: 100 }; // ≈ $1.0005/call at PRICING
      const { store, activities } = makeDeps([
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { q: 0 } }, expensive) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { q: 1 } }, expensive) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { q: 2 } }, expensive) },
        { kind: "respond", result: fakeIntent({ tool: "stub.lookup", args: { q: 3 } }, expensive) },
      ]);
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(
          env!.client,
          { ...runInput(runId), budget: { maxSteps: 100, maxCostUsd: 2.5 } },
          { taskQueue },
        );
        return handle.result();
      });

      // ~$1/call: within budget after 2 calls, over after the 3rd → trips before call 4
      expect(result).toEqual({ outcome: "budget_exceeded", reason: "MaxCostUsd", version: 15, steps: 3 });
      const { events, state } = await loadReplayed(store, runId);
      expect(events.filter((e) => e.type === "ModelCalled")).toHaveLength(3);
      expect(events.at(-2)?.type).toBe("BudgetExceeded");
      expect(events.at(-1)).toMatchObject({ type: "RunFailed", reason: "MaxCostUsd" });
      expect(state.status).toBe("failed");
      expect(state.costUsd).toBeGreaterThan(2.5); // overshoot bounded to the crossing call
      expect(state.costUsd).toBeLessThan(3.6);
    },
    120_000,
  );

  it(
    "determinism: replaying the completed workflow history raises no non-determinism errors",
    async (ctx) => {
      if (!env) return ctx.skip();
      const handle = env.client.workflow.getHandle("run-kill");
      const history = await handle.fetchHistory();
      await expect(
        Worker.runReplayHistory({ workflowsPath }, history, "run-kill"),
      ).resolves.not.toThrow();
    },
    120_000,
  );

  it("WORKER_READY is flipped by ticket 003", () => {
    expect(WORKER_READY).toBe(true);
  });
});
