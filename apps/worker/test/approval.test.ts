import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { replay, type RunEventType } from "@platform/core";
import type { InMemoryEventStore } from "@platform/storage";
import { fakeIntent, fakeMessage } from "@platform/model-gateway";
import { sendApprovalDecision, sendApprovalDelegation, startAgentRun } from "../src/client.js";
import { makeWorld, runInput } from "./helpers.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));

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
      console.warn(`[approval.test] SKIPPING: ephemeral server download blocked. Cause: ${message}`);
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

// prod + DEFAULT_RULES: the scripted write intent requires approval
const WRITE_SCRIPT = [
  { kind: "respond" as const, result: fakeIntent({ tool: "ticket.update@v1", args: { id: 42, status: "solved" } }) },
  { kind: "respond" as const, result: fakeMessage("ticket resolved") },
];

async function waitForVersion(store: InMemoryEventStore, runId: string, version: number) {
  for (let i = 0; i < 400; i++) {
    const loaded = await store.load(runId);
    if (loaded !== null && loaded.version >= version) return;
    await sleep(25);
  }
  throw new Error(`run ${runId} never reached version ${version}`);
}

async function eventTypes(store: InMemoryEventStore, runId: string): Promise<RunEventType[]> {
  const loaded = await store.load(runId);
  expect(loaded!.events.map((e) => e.seq)).toEqual([...loaded!.events.keys()]);
  return loaded!.events.map((e) => e.type);
}

describe("approval flow in the engine (ticket 017)", () => {
  it(
    "granted: a prod write pauses the run; a signal resumes it and the tool executes",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-approve";
      const taskQueue = "tq-approve";
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, { env: "prod" });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(
          env!.client,
          { ...runInput(runId), approvalTtlMs: 60_000 },
          { taskQueue },
        );
        await waitForVersion(store, runId, 5); // …ApprovalRequested landed
        const paused = replay((await store.load(runId))!.events);
        expect(paused.ok && paused.state.status).toBe("awaiting_approval");
        expect(writeExecuted).toHaveLength(0); // nothing executed while paused

        await sendApprovalDecision(env!.client, runId, {
          granted: true,
          by: "user:omar",
          comment: "looks right",
        });
        return handle.result();
      });

      expect(result.outcome).toBe("completed");
      expect(writeExecuted).toEqual([{ id: 42, status: "solved" }]);
      expect(await eventTypes(store, runId)).toEqual([
        "RunStarted",
        "ModelCalled",
        "ToolIntentEmitted",
        "PolicyEvaluated",
        "ApprovalRequested",
        "ApprovalGranted",
        "ToolExecuted",
        "ModelCalled",
        "RunCompleted",
      ]);
      const events = (await store.load(runId))!.events;
      expect(events[3]).toMatchObject({ decision: "require_approval", rule: "write-requires-approval" });
      expect(events[5]).toMatchObject({ by: "user:omar", comment: "looks right" });
    },
    120_000,
  );

  it(
    "denied: the tool never executes and the run continues to completion",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-deny";
      const taskQueue = "tq-deny";
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, { env: "prod" });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(
          env!.client,
          { ...runInput(runId), approvalTtlMs: 60_000 },
          { taskQueue },
        );
        await waitForVersion(store, runId, 5);
        await sendApprovalDecision(env!.client, runId, { granted: false, by: "user:omar" });
        return handle.result();
      });

      expect(result.outcome).toBe("completed");
      expect(writeExecuted).toHaveLength(0);
      expect(await eventTypes(store, runId)).toEqual([
        "RunStarted",
        "ModelCalled",
        "ToolIntentEmitted",
        "PolicyEvaluated",
        "ApprovalRequested",
        "ApprovalDenied",
        "ModelCalled",
        "RunCompleted",
      ]);
    },
    120_000,
  );

  it(
    "expiry: no decision before the ttl → denied by system:expiry, tool never executes",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-expire";
      const taskQueue = "tq-expire";
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, { env: "prod" });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(
          env!.client,
          { ...runInput(runId), approvalTtlMs: 1_500 },
          { taskQueue },
        );
        return handle.result(); // nobody answers
      });

      expect(result.outcome).toBe("completed");
      expect(writeExecuted).toHaveLength(0);
      const events = (await store.load(runId))!.events;
      const denied = events.find((e) => e.type === "ApprovalDenied");
      expect(denied).toMatchObject({ by: "system:expiry" });
    },
    120_000,
  );

  it(
    "kill test, approval edition: worker dies while awaiting approval; a fresh worker + late signal completes",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-approve-kill";
      const taskQueue = "tq-approve-kill";
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, { env: "prod" });

      const worker1 = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });
      const worker1Run = worker1.run();
      const handle = await startAgentRun(
        env.client,
        { ...runInput(runId), approvalTtlMs: 120_000 },
        { taskQueue },
      );
      await waitForVersion(store, runId, 5); // paused, awaiting approval
      worker1.shutdown();
      await worker1Run;

      const worker2 = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });
      const result = await worker2.runUntil(async () => {
        await sendApprovalDecision(env!.client, runId, { granted: true, by: "user:omar" });
        return handle.result();
      });

      expect(result.outcome).toBe("completed");
      expect(writeExecuted).toHaveLength(1); // executed exactly once, after the kill
      const types = await eventTypes(store, runId); // contiguous seq asserted inside
      expect(types.filter((t) => t === "ApprovalRequested")).toHaveLength(1);
      expect(types.filter((t) => t === "ToolExecuted")).toHaveLength(1);
    },
    120_000,
  );

  it(
    "environment split: the identical write auto-executes in dev, by policy alone",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-envsplit-dev";
      const taskQueue = "tq-envsplit-dev";
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, { env: "dev" });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(env!.client, runInput(runId), { taskQueue });
        return handle.result(); // nobody approves anything — dev doesn't ask
      });

      expect(result.outcome).toBe("completed");
      expect(writeExecuted).toEqual([{ id: 42, status: "solved" }]);
      expect(await eventTypes(store, runId)).toEqual([
        "RunStarted",
        "ModelCalled",
        "ToolIntentEmitted",
        "PolicyEvaluated", // allow, write-dev-auto-allow — no approval events at all
        "ToolExecuted",
        "ModelCalled",
        "RunCompleted",
      ]);
      const events = (await store.load(runId))!.events;
      expect(events[3]).toMatchObject({ decision: "allow", rule: "write-dev-auto-allow" });
    },
    120_000,
  );

  it(
    "out-of-grant intents are refused-and-audited; the run survives",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-ungranted";
      const taskQueue = "tq-ungranted";
      const { store, activities } = makeWorld(
        [
          { kind: "respond", result: fakeIntent({ tool: "payments.exfiltrate@v1", args: { to: "attacker" } }) },
          { kind: "respond", result: fakeMessage("recovered") },
        ],
        { env: "prod" },
      );
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

      expect(result.outcome).toBe("completed");
      const events = (await store.load(runId))!.events;
      expect(events.map((e) => e.type)).toEqual([
        "RunStarted",
        "ModelCalled",
        "ToolIntentEmitted", // the ATTEMPT is audited…
        "PolicyEvaluated", // …with the gateway's refusal
        "ModelCalled",
        "RunCompleted",
      ]);
      expect(events[3]).toMatchObject({ decision: "deny", rule: "gateway:not_granted" });
      expect(events[2]).toMatchObject({ risk: "irreversible" }); // unknown capability = worst tier
    },
    120_000,
  );

  it(
    "escalation (ticket 048): silence at afterMs escalates in the log; the ORIGINAL expiry still denies",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-escalate-expire";
      const taskQueue = "tq-escalate-expire";
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, { env: "prod" });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(
          env!.client,
          {
            ...runInput(runId),
            approvalTtlMs: 3_000,
            escalation: { toGroup: "managers", afterMs: 1_000 },
          },
          { taskQueue },
        );
        return handle.result(); // nobody ever answers
      });

      expect(result.outcome).toBe("completed");
      expect(writeExecuted).toHaveLength(0); // escalation buys attention, never execution
      const events = (await store.load(runId))!.events;
      const types = events.map((e) => e.type);
      expect(types).toContain("ApprovalEscalated");
      expect(types.indexOf("ApprovalEscalated")).toBeLessThan(types.indexOf("ApprovalDenied"));
      expect(events.find((e) => e.type === "ApprovalEscalated")).toMatchObject({
        toGroup: "managers",
      });
      expect(events.find((e) => e.type === "ApprovalDenied")).toMatchObject({
        by: "system:expiry",
      });
    },
    120_000,
  );

  it(
    "escalation (ticket 048): a decision BEFORE afterMs leaves no escalation event; a grant after escalation executes once",
    async (ctx) => {
      if (!env) return ctx.skip();
      const taskQueue = "tq-escalate-decide";
      const { store, activities, writeExecuted } = makeWorld(
        [...WRITE_SCRIPT, ...WRITE_SCRIPT],
        { env: "prod" },
      );
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      await worker.runUntil(async () => {
        // decision-first: escalation point far away, approve immediately
        const fast = await startAgentRun(
          env!.client,
          {
            ...runInput("run-decide-first"),
            approvalTtlMs: 60_000,
            escalation: { toGroup: "managers", afterMs: 30_000 },
          },
          { taskQueue },
        );
        await waitForVersion(store, "run-decide-first", 5);
        await sendApprovalDecision(env!.client, "run-decide-first", {
          granted: true,
          by: "user:fast",
        });
        expect((await fast.result()).outcome).toBe("completed");

        // escalate-then-grant: silence past afterMs, then approval executes
        const slow = await startAgentRun(
          env!.client,
          {
            ...runInput("run-grant-after-escalation"),
            approvalTtlMs: 60_000,
            escalation: { toGroup: "managers", afterMs: 1_000 },
          },
          { taskQueue },
        );
        await waitForVersion(store, "run-grant-after-escalation", 6); // …ApprovalEscalated landed
        await sendApprovalDecision(env!.client, "run-grant-after-escalation", {
          granted: true,
          by: "user:mgr",
        });
        expect((await slow.result()).outcome).toBe("completed");
      });

      expect(await eventTypes(store, "run-decide-first")).not.toContain("ApprovalEscalated");
      const slowTypes = await eventTypes(store, "run-grant-after-escalation");
      expect(slowTypes.filter((t) => t === "ApprovalEscalated")).toHaveLength(1); // exactly once
      expect(slowTypes).toEqual([
        "RunStarted",
        "ModelCalled",
        "ToolIntentEmitted",
        "PolicyEvaluated",
        "ApprovalRequested",
        "ApprovalEscalated",
        "ApprovalGranted",
        "ToolExecuted",
        "ModelCalled",
        "RunCompleted",
      ]);
      expect(writeExecuted).toHaveLength(2); // one execution per run, no double-fire
    },
    120_000,
  );

  it(
    "delegation (ticket 050): the handoff lands in the log via the workflow; the delegate's grant executes",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-delegate";
      const taskQueue = "tq-delegate";
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, { env: "prod" });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(
          env!.client,
          { ...runInput(runId), approvalTtlMs: 60_000 },
          { taskQueue },
        );
        await waitForVersion(store, runId, 5); // paused, awaiting approval
        await sendApprovalDelegation(env!.client, runId, {
          toPrincipal: "user:omar",
          by: "user:lead",
        });
        await waitForVersion(store, runId, 6); // the handoff is a FACT in the log
        await sendApprovalDecision(env!.client, runId, { granted: true, by: "user:omar" });
        return handle.result();
      });

      expect(result.outcome).toBe("completed");
      expect(writeExecuted).toHaveLength(1); // exactly once
      expect(await eventTypes(store, runId)).toEqual([
        "RunStarted",
        "ModelCalled",
        "ToolIntentEmitted",
        "PolicyEvaluated",
        "ApprovalRequested",
        "ApprovalDelegated",
        "ApprovalGranted",
        "ToolExecuted",
        "ModelCalled",
        "RunCompleted",
      ]);
      const events = (await store.load(runId))!.events;
      expect(events.find((e) => e.type === "ApprovalDelegated")).toMatchObject({
        toPrincipal: "user:omar",
        by: "user:lead",
      });
      expect(events.find((e) => e.type === "ApprovalGranted")).toMatchObject({
        by: "user:omar", // the audit's who is the delegate who clicked
      });
    },
    120_000,
  );
});
