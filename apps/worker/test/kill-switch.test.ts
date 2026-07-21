import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { InMemoryEventStore } from "@platform/storage";
import { fakeIntent, fakeMessage } from "@platform/model-gateway";
import type { Activities } from "../src/activities.js";
import { sendApprovalDecision, startAgentRun } from "../src/client.js";
import { makeWorld, runInput, TEST_AGENT } from "./helpers.js";

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
      console.warn(`[kill-switch.test] SKIPPING: ephemeral server download blocked. Cause: ${message}`);
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

const OFF = { killSwitches: { global: false, agents: {} } };
const TRIPPED = { killSwitches: { global: true, agents: {} } };

// a run that wants several steps: two reads, then a message
const MULTI_STEP = [
  { kind: "respond" as const, result: fakeIntent({ tool: "stub.lookup@v1", args: { q: 1 } }) },
  { kind: "respond" as const, result: fakeIntent({ tool: "stub.lookup@v1", args: { q: 2 } }) },
  { kind: "respond" as const, result: fakeMessage("all done") },
];

describe("kill switches, engine edition (ticket 033)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kill-switch-"));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "a flipped switch stops an IN-FLIGHT run at its next step, typed and audited",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-kill-switch";
      const taskQueue = "tq-kill-switch";
      const limitsPath = join(dir, "midflight.json");
      await writeFile(limitsPath, JSON.stringify(OFF));

      const { store, activities: real } = makeWorld(MULTI_STEP, { limitsPath });
      // flip the switch AFTER the first model call returns — deterministic
      let calls = 0;
      const activities: Activities = {
        ...real,
        async callModel(request) {
          const result = await real.callModel(request);
          calls += 1;
          if (calls === 1) await writeFile(limitsPath, JSON.stringify(TRIPPED));
          return result;
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

      expect(result).toMatchObject({ outcome: "budget_exceeded", reason: "KilledBySwitch" });
      const events = (await store.load(runId))!.events;
      const types = events.map((e) => e.type);
      // one full step ran, then the switch killed the run before step two
      expect(types.filter((t) => t === "ModelCalled")).toHaveLength(1);
      expect(types.slice(-2)).toEqual(["BudgetExceeded", "RunFailed"]);
      const exceeded = events.find((e) => e.type === "BudgetExceeded");
      expect(exceeded).toMatchObject({ reason: "KilledBySwitch" });
    },
    120_000,
  );

  it(
    "cancel beats approval (ticket 064): a per-run switch tripped during the pause kills the run before the approved write",
    async (ctx) => {
      if (!env) return ctx.skip();
      const runId = "run-cancelled-while-paused";
      const taskQueue = "tq-cancel-paused";
      const limitsPath = join(dir, "cancel.json");
      await writeFile(limitsPath, JSON.stringify(OFF));

      // prod + DEFAULT_RULES: the write intent pauses for approval
      const WRITE_SCRIPT = [
        {
          kind: "respond" as const,
          result: fakeIntent({ tool: "ticket.update@v1", args: { id: 7, status: "solved" } }),
        },
        { kind: "respond" as const, result: fakeMessage("never reached") },
      ];
      const { store, activities, writeExecuted } = makeWorld(WRITE_SCRIPT, {
        env: "prod",
        limitsPath,
      });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const waitForVersion = async (s: InMemoryEventStore, id: string, version: number) => {
        for (let i = 0; i < 400; i++) {
          const loaded = await s.load(id);
          if (loaded !== null && loaded.version >= version) return;
          await sleep(25);
        }
        throw new Error(`run ${id} never reached version ${version}`);
      };

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(
          env!.client,
          { ...runInput(runId), approvalTtlMs: 60_000 },
          { taskQueue },
        );
        await waitForVersion(store, runId, 5); // …ApprovalRequested landed
        // the operator cancels THIS run while it waits in the inbox
        await writeFile(
          limitsPath,
          JSON.stringify({ killSwitches: { global: false, agents: {}, runs: { [runId]: true } } }),
        );
        // …and someone approves anyway. The lever must win.
        await sendApprovalDecision(env!.client, runId, { granted: true, by: "user:late" });
        return handle.result();
      });

      expect(result).toMatchObject({ outcome: "budget_exceeded", reason: "KilledBySwitch" });
      expect(writeExecuted).toHaveLength(0); // the approved write never executed
      const events = (await store.load(runId))!.events;
      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "RunStarted",
        "ModelCalled",
        "ToolIntentEmitted",
        "PolicyEvaluated",
        "ApprovalRequested",
        "ApprovalGranted",
        "BudgetExceeded",
        "RunFailed",
      ]);
      expect(events.find((e) => e.type === "BudgetExceeded")).toMatchObject({
        reason: "KilledBySwitch",
        detail: `run ${runId} was cancelled by an operator`,
      });
    },
    120_000,
  );

  it(
    "a pre-tripped per-agent switch stops a NEW run at start; other agents run",
    async (ctx) => {
      if (!env) return ctx.skip();
      const taskQueue = "tq-kill-switch-start";
      const limitsPath = join(dir, "atstart.json");
      await writeFile(
        limitsPath,
        JSON.stringify({ killSwitches: { global: false, agents: { [TEST_AGENT]: true } } }),
      );
      const { store, activities } = makeWorld(
        [{ kind: "respond", result: fakeMessage("should not be reached for stub-agent") }],
        { limitsPath },
      );
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath,
        activities,
      });

      const result = await worker.runUntil(async () => {
        const handle = await startAgentRun(env!.client, runInput("run-switched-off"), { taskQueue });
        return handle.result();
      });

      expect(result).toMatchObject({ outcome: "budget_exceeded", reason: "KilledBySwitch", steps: 0 });
      const events = (await store.load("run-switched-off"))!.events;
      expect(events.map((e) => e.type)).toEqual(["RunStarted", "BudgetExceeded", "RunFailed"]);
      expect(events.filter((e) => e.type === "ModelCalled")).toHaveLength(0); // never reached a model
    },
    120_000,
  );
});
