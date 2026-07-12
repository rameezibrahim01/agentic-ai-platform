import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fakeMessage } from "@platform/model-gateway";
import { startAgentRun, taskQueueFor, workflowIdFor } from "../src/client.js";
import { makeTenantLimitsLoader } from "../src/limits.js";
import { makeWorld, runInput, TEST_AGENT } from "./helpers.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));

// Ticket 037: one worker process, isolated lanes. Isolation here is BY
// CONSTRUCTION — each lane's activities were built holding exactly one
// tenant's store — and these tests prove the construction, not a filter.

describe("tenant lane naming (ticket 037)", () => {
  it("maps tenants to queues and workflowIds; untenanted stays byte-identical", () => {
    expect(taskQueueFor()).toBe("agent-runs");
    expect(taskQueueFor("acme")).toBe("agent-runs--acme");
    expect(taskQueueFor("globex-inc")).toBe("agent-runs--globex-inc");
    expect(workflowIdFor("run-1")).toBe("run-1");
    expect(workflowIdFor("run-1", "acme")).toBe("acme--run-1");
  });
});

// Same CI-authoritative pattern as workflow.test.ts: the ephemeral server
// downloads in CI; egress-restricted sandboxes skip loudly, never in CI.
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
    if (/Failed to start ephemeral server.*temporal\.download/s.test(message) && !process.env["CI"]) {
      console.warn(`[tenant-lanes.test] SKIPPING: ephemeral server download blocked. Cause: ${message}`);
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

describe("tenant-scoped engine lanes (ticket 037)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tenant-lanes-"));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "a run on tenant A's queue lands ONLY in A's store; B's store is byte-identical before/after",
    async (ctx) => {
      if (!env) return ctx.skip();
      const worldA = makeWorld([{ kind: "respond", result: fakeMessage("acme lane") }]);
      const worldB = makeWorld([{ kind: "respond", result: fakeMessage("globex lane") }]);
      const workerA = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueueFor("acme"),
        workflowsPath,
        activities: worldA.activities,
      });
      const workerB = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueueFor("globex"),
        workflowsPath,
        activities: worldB.activities,
      });

      await workerA.runUntil(() =>
        workerB.runUntil(async () => {
          const bBefore = JSON.stringify(await worldB.store.listRuns());
          const handle = await startAgentRun(env!.client, runInput("run-a-only"), {
            tenant: "acme",
          });
          expect(handle.workflowId).toBe("acme--run-a-only");
          const result = await handle.result();
          expect(result).toMatchObject({ outcome: "completed" });
          expect(JSON.stringify(await worldB.store.listRuns())).toBe(bBefore);
        }),
      );

      expect(await worldA.store.load("run-a-only")).not.toBeNull();
      expect(await worldB.store.load("run-a-only")).toBeNull();
      expect(await worldB.store.listRuns()).toEqual([]);
    },
    120_000,
  );

  it(
    "the same runId started on both tenants' queues yields two independent runs",
    async (ctx) => {
      if (!env) return ctx.skip();
      const worldA = makeWorld([{ kind: "respond", result: fakeMessage("acme copy") }]);
      const worldB = makeWorld([{ kind: "respond", result: fakeMessage("globex copy") }]);
      const workerA = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueueFor("acme"),
        workflowsPath,
        activities: worldA.activities,
      });
      const workerB = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueueFor("globex"),
        workflowsPath,
        activities: worldB.activities,
      });

      await workerA.runUntil(() =>
        workerB.runUntil(async () => {
          const handleA = await startAgentRun(env!.client, runInput("run-shared"), {
            tenant: "acme",
          });
          const handleB = await startAgentRun(env!.client, runInput("run-shared"), {
            tenant: "globex",
          });
          expect(handleA.workflowId).not.toBe(handleB.workflowId);
          expect((await handleA.result()).outcome).toBe("completed");
          expect((await handleB.result()).outcome).toBe("completed");
        }),
      );

      // two independent event logs, one per tenant store, same runId inside
      const inA = await worldA.store.load("run-shared");
      const inB = await worldB.store.load("run-shared");
      expect(inA).not.toBeNull();
      expect(inB).not.toBeNull();
      expect(inA!.events[0]).toMatchObject({ type: "RunStarted", runId: "run-shared" });
      expect(inB!.events[0]).toMatchObject({ type: "RunStarted", runId: "run-shared" });
    },
    120_000,
  );

  it(
    "tenant A's kill switch stops A's lane; B's lane (fallback to shared limits) completes",
    async (ctx) => {
      if (!env) return ctx.skip();
      // the exact per-tenant wiring the worker boots with: limits.<id>.config.json
      // beside the shared file wins when present, missing falls back to shared
      const sharedPath = join(dir, "limits.config.json");
      await writeFile(sharedPath, JSON.stringify({ killSwitches: { global: false, agents: {} } }));
      const acmePath = join(dir, "limits.acme.config.json");
      await writeFile(
        acmePath,
        JSON.stringify({ killSwitches: { global: false, agents: { [TEST_AGENT]: true } } }),
      );

      const worldA = makeWorld([{ kind: "respond", result: fakeMessage("never reached") }], {
        limitsLoader: makeTenantLimitsLoader(acmePath, sharedPath),
      });
      const worldB = makeWorld([{ kind: "respond", result: fakeMessage("globex unaffected") }], {
        limitsLoader: makeTenantLimitsLoader(join(dir, "limits.globex.config.json"), sharedPath),
      });
      const workerA = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueueFor("acme"),
        workflowsPath,
        activities: worldA.activities,
      });
      const workerB = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueueFor("globex"),
        workflowsPath,
        activities: worldB.activities,
      });

      await workerA.runUntil(() =>
        workerB.runUntil(async () => {
          const handleA = await startAgentRun(env!.client, runInput("run-killed"), {
            tenant: "acme",
          });
          const handleB = await startAgentRun(env!.client, runInput("run-alive"), {
            tenant: "globex",
          });
          expect(await handleA.result()).toMatchObject({
            outcome: "budget_exceeded",
            reason: "KilledBySwitch",
            steps: 0,
          });
          expect(await handleB.result()).toMatchObject({ outcome: "completed" });
        }),
      );

      const killed = (await worldA.store.load("run-killed"))!.events;
      expect(killed.map((e) => e.type)).toEqual(["RunStarted", "BudgetExceeded", "RunFailed"]);
      const alive = (await worldB.store.load("run-alive"))!.events;
      expect(alive.map((e) => e.type)).toContain("RunCompleted");
      // the kill never leaked across lanes
      expect(await worldB.store.load("run-killed")).toBeNull();
    },
    120_000,
  );
});
