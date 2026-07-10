import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { replay } from "@platform/core";
import { verifyDelegation, type StandingGrant } from "@platform/identity";
import type { InMemoryEventStore } from "@platform/storage";
import { fakeIntent, fakeMessage } from "@platform/model-gateway";
import {
  createAgentSchedule,
  deleteAgentSchedule,
  triggerAgentSchedule,
} from "../src/schedules.js";
import { makeWorld, TEST_AGENT } from "./helpers.js";

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
      console.warn(`[grants.test] SKIPPING: ephemeral server download blocked. Cause: ${message}`);
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

const SECRET = "drill-delegation-secret";
const PRINCIPAL = "user:oncall";

// A scheduled write agent: one governed write intent, then done.
const NIGHTLY_SCRIPT = [
  { kind: "respond" as const, result: fakeIntent({ tool: "ticket.update@v1", args: { id: 7, status: "triaged" } }) },
  { kind: "respond" as const, result: fakeMessage("nightly triage complete") },
];

// Far-future calendar spec so occurrences only happen via trigger().
const NEVER_CRON = "59 23 31 12 *";

const grantFor = (scheduleId: string): StandingGrant => ({
  id: `grant-${scheduleId}`,
  principal: PRINCIPAL,
  scheduleId,
  tools: [{ name: "ticket.update", version: "v1" }],
  risks: ["write"],
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
});

const template = {
  agent: TEST_AGENT,
  principal: PRINCIPAL,
  input: { source: "schedule" },
  model: "fake-model",
  prompt: "triage the queue",
};

async function waitForCompleted(store: InMemoryEventStore): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const runs = await store.listRuns({ status: "completed" });
    if (runs.length > 0) return runs[0]!.runId;
    await sleep(50);
  }
  throw new Error("scheduled occurrence never completed");
}

describe("resolveStandingGrant activity (ticket 020)", () => {
  it("valid grant → per-occurrence delegation scoped exactly to the grant + audit record", async () => {
    const { activities, grantStore } = makeWorld(NIGHTLY_SCRIPT, { delegation: { secret: SECRET } });
    const grant = grantFor("nightly");
    expect((await grantStore.create(grant)).ok).toBe(true);

    const before = Date.now();
    const resolved = await activities.resolveStandingGrant({
      grantId: grant.id,
      runId: "nightly-occurrence-1",
      agent: TEST_AGENT,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.exercise).toMatchObject({
      grantId: grant.id,
      principal: PRINCIPAL,
      scheduleId: "nightly",
      runId: "nightly-occurrence-1",
    });
    const verified = verifyDelegation(resolved.delegation, SECRET, Date.now());
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims).toMatchObject({
        principal: PRINCIPAL,
        agent: TEST_AGENT,
        env: "dev",
        runId: "nightly-occurrence-1",
        tools: grant.tools,
        risks: grant.risks,
      });
      // capped: never beyond the grant, never beyond now + default ttl
      expect(verified.claims.exp).toBeLessThanOrEqual(grant.expiresAt);
      expect(verified.claims.exp).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
      expect(verified.claims.exp).toBeGreaterThanOrEqual(before);
    }
  });

  it("revoked / expired / unknown grants are typed refusals — no delegation minted", async () => {
    const { activities, grantStore } = makeWorld(NIGHTLY_SCRIPT, { delegation: { secret: SECRET } });
    const revokedGrant = grantFor("revoked-sched");
    await grantStore.create(revokedGrant);
    await grantStore.revoke(revokedGrant.id, Date.now());
    const expiredGrant: StandingGrant = { ...grantFor("expired-sched"), id: "g-exp", expiresAt: 1 };
    await grantStore.create(expiredGrant);

    const occurrence = { runId: "r1", agent: TEST_AGENT };
    expect(await activities.resolveStandingGrant({ ...occurrence, grantId: revokedGrant.id }))
      .toEqual({ ok: false, reason: "revoked" });
    expect(await activities.resolveStandingGrant({ ...occurrence, grantId: expiredGrant.id }))
      .toEqual({ ok: false, reason: "expired" });
    expect(await activities.resolveStandingGrant({ ...occurrence, grantId: "ghost" }))
      .toEqual({ ok: false, reason: "not_found" });
  });

  it("a world without a grant store refuses with grants_not_configured", async () => {
    const { activities } = makeWorld(NIGHTLY_SCRIPT);
    expect(
      await activities.resolveStandingGrant({ grantId: "any", runId: "r1", agent: TEST_AGENT }),
    ).toEqual({ ok: false, reason: "grants_not_configured" });
  });
});

describe("the 2 a.m. drill (ticket 020)", () => {
  it(
    "a scheduled occurrence executes a governed write under a standing grant, exercise audited",
    async (ctx) => {
      if (!env) return ctx.skip();
      const scheduleId = "sched-2am-drill";
      const taskQueue = "tq-2am-drill";
      // dev world, but the gateway REQUIRES a delegation: the write only
      // happens if the standing grant actually resolved into a credential.
      const { store, activities, writeExecuted, grantStore } = makeWorld(NIGHTLY_SCRIPT, {
        delegation: { secret: SECRET },
      });
      const grant = grantFor(scheduleId);
      expect((await grantStore.create(grant)).ok).toBe(true);

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
        standingGrantId: grant.id,
      });
      try {
        const runId = await worker.runUntil(async () => {
          await triggerAgentSchedule(env!.client, scheduleId);
          return waitForCompleted(store);
        });

        // the governed write actually executed, exactly once
        expect(writeExecuted).toEqual([{ id: 7, status: "triaged" }]);
        expect(runId.startsWith(`${scheduleId}-`)).toBe(true);

        const events = (await store.load(runId))!.events;
        expect(events.map((e) => e.type)).toEqual([
          "RunStarted",
          "ModelCalled",
          "ToolIntentEmitted",
          "PolicyEvaluated", // allow, write-dev-auto-allow — delegation already checked
          "ToolExecuted",
          "ModelCalled",
          "RunCompleted",
        ]);
        // the exercise is part of the run's audited input, delegated principal in the log
        expect(events[0]).toMatchObject({
          principal: PRINCIPAL,
          input: {
            source: "schedule",
            grantExercise: { grantId: grant.id, principal: PRINCIPAL, scheduleId, runId },
          },
        });
        expect(events[3]).toMatchObject({ decision: "allow", rule: "write-dev-auto-allow" });
        const replayed = replay(events);
        expect(replayed.ok && replayed.state.status).toBe("completed");
      } finally {
        await deleteAgentSchedule(env.client, scheduleId);
      }
    },
    120_000,
  );

  it(
    "revocation drill: after revoke, the next occurrence is refused at the delegation check",
    async (ctx) => {
      if (!env) return ctx.skip();
      const scheduleId = "sched-revoked-drill";
      const taskQueue = "tq-revoked-drill";
      const { store, activities, writeExecuted, grantStore } = makeWorld(NIGHTLY_SCRIPT, {
        delegation: { secret: SECRET },
      });
      const grant = grantFor(scheduleId);
      await grantStore.create(grant);
      await grantStore.revoke(grant.id, Date.now()); // one click, permanent

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
        standingGrantId: grant.id,
      });
      try {
        const runId = await worker.runUntil(async () => {
          await triggerAgentSchedule(env!.client, scheduleId);
          return waitForCompleted(store);
        });

        // nothing executed, no broader credential — but the run SURVIVED,
        // and the refused attempt is fully audited.
        expect(writeExecuted).toHaveLength(0);
        const events = (await store.load(runId))!.events;
        expect(events.map((e) => e.type)).toEqual([
          "RunStarted",
          "ModelCalled",
          "ToolIntentEmitted", // the attempt is audited…
          "PolicyEvaluated", // …refused at the delegation check
          "ModelCalled",
          "RunCompleted",
        ]);
        expect(events[3]).toMatchObject({ decision: "deny", rule: "gateway:delegation_missing" });
        // no exercise recorded: the revoked grant minted nothing
        expect((events[0] as { input?: Record<string, unknown> }).input).toEqual({
          source: "schedule",
        });
        const replayed = replay(events);
        expect(replayed.ok && replayed.state.status).toBe("completed");
      } finally {
        await deleteAgentSchedule(env.client, scheduleId);
      }
    },
    120_000,
  );
});
