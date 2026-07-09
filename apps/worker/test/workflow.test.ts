import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { replay, type RunEventType } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
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

/** Expected log shape for a completed scripted run. */
function expectedTypes(scriptSteps: number): RunEventType[] {
  const types: RunEventType[] = ["RunStarted"];
  for (let i = 0; i < scriptSteps; i++) {
    types.push("ModelCalled", "ToolIntentEmitted", "PolicyEvaluated", "ToolExecuted");
  }
  types.push("RunCompleted");
  return types;
}

async function assertCleanLog(
  store: InMemoryEventStore,
  runId: string,
  scriptSteps: number,
): Promise<void> {
  const loaded = await store.load(runId);
  expect(loaded).not.toBeNull();
  // zero duplicated events: strictly contiguous seq starting at 0…
  expect(loaded!.events.map((e) => e.seq)).toEqual([...loaded!.events.keys()]);
  // …and exactly the scripted shape, nothing extra
  expect(loaded!.events.map((e) => e.type)).toEqual(expectedTypes(scriptSteps));
  const replayed = replay(loaded!.events);
  expect(replayed.ok).toBe(true);
  if (replayed.ok) {
    expect(replayed.state.status).toBe("completed");
    expect(replayed.state.stepCount).toBe(scriptSteps);
  }
}

describe("agentRun workflow (ticket 003)", () => {
  it(
    "kill test: worker dies mid-run; a fresh worker completes it with zero duplicated events",
    async (ctx) => {
      if (!env) return ctx.skip();
      const store = new InMemoryEventStore();
      const real = createActivities(store);
      const runId = "run-kill";
      const scriptSteps = 4;
      const taskQueue = "tq-kill-test";

      // Worker 1 executes steps 0–1, then starts failing — simulating a worker
      // that dies partway through the run, between two activities.
      let worker1Refusals = 0;
      const activities1: Activities = {
        ...real,
        async callModel(request) {
          if (request.step >= 2) {
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

      const handle = await startAgentRun(
        env.client,
        { runId, agent: "stub-agent@v1", principal: "user:test", input: { q: 1 }, scriptSteps },
        { taskQueue },
      );

      // Wait until worker1 has demonstrably progressed into the run and hit the wall.
      while (worker1Refusals === 0) {
        await sleep(25);
      }
      worker1.shutdown();
      await worker1Run;
      expect((await store.load(runId))!.version).toBeGreaterThanOrEqual(9); // steps 0–1 landed
      expect((await store.load(runId))!.version).toBeLessThan(18); // run genuinely unfinished

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

      expect(result).toEqual({ outcome: "completed", version: 18, steps: scriptSteps });
      expect(worker2ModelCalls).toBeGreaterThan(0); // worker2 did real work
      await assertCleanLog(store, runId, scriptSteps);
    },
    120_000,
  );

  it(
    "retry test: an activity that fails after appending yields exactly one appended event set",
    async (ctx) => {
      if (!env) return ctx.skip();
      const store = new InMemoryEventStore();
      const real = createActivities(store);
      const runId = "run-retry";
      const scriptSteps = 1;
      const taskQueue = "tq-retry-test";

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
        const handle = await startAgentRun(
          env.client,
          { runId, agent: "stub-agent@v1", principal: "user:test", input: {}, scriptSteps },
          { taskQueue },
        );
        return handle.result();
      });

      expect(executeToolAttempts).toBe(2); // retried…
      expect(result.outcome).toBe("completed");
      await assertCleanLog(store, runId, scriptSteps); // …but appended exactly once
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
