import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import { replay } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import { createGateway, FakeProvider, fakeMessage, type FakeBehavior } from "@platform/model-gateway";
import { createActivities, type Activities } from "../src/activities.js";
import {
  createAgentSchedule,
  deleteAgentSchedule,
  describeAgentSchedule,
  pauseAgentSchedule,
  resumeAgentSchedule,
  triggerAgentSchedule,
} from "../src/schedules.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));

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
      console.warn(`[schedules.test] SKIPPING: ephemeral server download blocked. Cause: ${message}`);
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

// Far-future calendar spec so occurrences only happen via trigger().
const NEVER_CRON = "59 23 31 12 *";

function makeDeps(script: readonly FakeBehavior[]) {
  const store = new InMemoryEventStore();
  const gateway = createGateway({
    env: "test",
    allowlist: ["fake-model"],
    pricing: { "fake-model": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    providers: [{ name: "fake", provider: new FakeProvider(script) }],
  });
  return { store, activities: createActivities({ store, gateway }) };
}

const template = {
  agent: "scheduled-agent@v1",
  principal: "user:scheduler",
  input: { source: "schedule" },
  model: "fake-model",
  prompt: "check the queue",
};

describe("thin schedules (ticket 010)", () => {
  it(
    "create/describe: pinned timezone, SKIP overlap, explicit catch-up; pause/resume round-trips",
    async (ctx) => {
      if (!env) return ctx.skip();
      const scheduleId = "sched-describe";
      await createAgentSchedule(env.client, {
        scheduleId,
        cron: NEVER_CRON,
        timezone: "America/Chicago",
        template,
        catchupWindowMs: 0, // explicit decision: drop missed occurrences
        paused: true,
      });
      try {
        const description = await describeAgentSchedule(env.client, scheduleId);
        expect(description.spec.timezone).toBe("America/Chicago");
        expect(description.policies.overlap).toBe(ScheduleOverlapPolicy.SKIP);
        // "drop missed occurrences" maps to the server-minimum 10s window
        expect(description.policies.catchupWindow).toBe(10_000);
        expect(description.state.paused).toBe(true);

        await resumeAgentSchedule(env.client, scheduleId, "resuming for test");
        expect((await describeAgentSchedule(env.client, scheduleId)).state.paused).toBe(false);
        await pauseAgentSchedule(env.client, scheduleId, "pausing again");
        expect((await describeAgentSchedule(env.client, scheduleId)).state.paused).toBe(true);
      } finally {
        await deleteAgentSchedule(env.client, scheduleId);
      }
    },
    120_000,
  );

  it(
    "trigger: an occurrence executes agentRun end-to-end with the deterministic occurrence runId",
    async (ctx) => {
      if (!env) return ctx.skip();
      const scheduleId = "sched-trigger";
      const taskQueue = "tq-sched-trigger";
      const { store, activities } = makeDeps([
        { kind: "respond", result: fakeMessage("morning check done") },
      ]);
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      await createAgentSchedule(env.client, {
        scheduleId,
        cron: NEVER_CRON,
        timezone: "UTC",
        template,
        catchupWindowMs: 0,
        taskQueue,
      });
      try {
        await worker.runUntil(async () => {
          await triggerAgentSchedule(env!.client, scheduleId);
          // wait for the occurrence's run to land in the event store
          for (let i = 0; i < 400; i++) {
            const runs = await store.listRuns({ status: "completed" });
            if (runs.length > 0) return;
            await sleep(50);
          }
          throw new Error("scheduled occurrence never completed");
        });

        const runs = await store.listRuns();
        expect(runs).toHaveLength(1);
        const runId = runs[0]!.runId;
        // deterministic per-occurrence id: <scheduleId>-<occurrence time>
        expect(runId.startsWith(`${scheduleId}-`)).toBe(true);
        const loaded = await store.load(runId);
        const replayed = replay(loaded!.events);
        expect(replayed.ok).toBe(true);
        if (replayed.ok) {
          expect(replayed.state.status).toBe("completed");
          expect(replayed.state.agent).toBe(template.agent);
        }
      } finally {
        await deleteAgentSchedule(env.client, scheduleId);
      }
    },
    120_000,
  );

  it(
    "overlap SKIP: while an occurrence is running, a second trigger starts nothing",
    async (ctx) => {
      if (!env) return ctx.skip();
      const scheduleId = "sched-overlap";
      const taskQueue = "tq-sched-overlap";
      const { store, activities: real } = makeDeps([
        { kind: "respond", result: fakeMessage("slow run done") },
      ]);

      // gate the first occurrence so it stays running
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let modelCalls = 0;
      const activities: Activities = {
        ...real,
        async callModel(request) {
          modelCalls += 1;
          await gate;
          return real.callModel(request);
        },
      };
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      await createAgentSchedule(env.client, {
        scheduleId,
        cron: NEVER_CRON,
        timezone: "UTC",
        template,
        catchupWindowMs: 0,
        taskQueue,
      });
      try {
        await worker.runUntil(async () => {
          await triggerAgentSchedule(env!.client, scheduleId);
          // first occurrence is now in flight (blocked at the gate)
          for (let i = 0; i < 200 && modelCalls === 0; i++) await sleep(25);
          expect(modelCalls).toBe(1);

          await triggerAgentSchedule(env!.client, scheduleId); // must be skipped
          await sleep(1_500); // give a wrongly-started second occurrence time to appear

          const description = await describeAgentSchedule(env!.client, scheduleId);
          expect(description.info.runningActions).toHaveLength(1); // still just one
          expect((await store.listRuns())).toHaveLength(1); // and only one run exists

          release();
          for (let i = 0; i < 400; i++) {
            const done = await store.listRuns({ status: "completed" });
            if (done.length === 1) return;
            await sleep(50);
          }
          throw new Error("gated occurrence never completed");
        });

        // after release: still exactly one run ever started
        expect(await store.listRuns()).toHaveLength(1);
      } finally {
        await deleteAgentSchedule(env.client, scheduleId);
      }
    },
    120_000,
  );
});
