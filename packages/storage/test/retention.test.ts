import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import {
  applyRetention,
  InMemoryEventStore,
  InMemoryHoldStore,
  migrate,
  PostgresHoldStore,
} from "@platform/storage";
import type { HoldStore } from "@platform/storage";

// Ticket 032: retention deletes whole TERMINAL runs by explicit policy;
// legal hold beats every policy; every considered run is accounted for.

function run(runId: string, endedAt: number, terminal: "completed" | "running"): RunEvent[] {
  const events: RunEvent[] = [
    { type: "RunStarted", runId, seq: 0, at: endedAt - 100, agent: "a@v1", principal: "user:x", input: {} },
    { type: "ModelCalled", runId, seq: 1, at: endedAt - 50, gatewayReqId: "g", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 },
  ];
  if (terminal === "completed") {
    events.push({ type: "RunCompleted", runId, seq: 2, at: endedAt, outcome: "done", totalCostUsd: 0, steps: 1 });
  }
  return events;
}

const NOW = 10_000_000;
const MAX_AGE = 1_000_000;

describe("retention (ticket 032)", () => {
  it("property: exactly the terminal, unheld, over-age runs are deleted — everything else is accounted for", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            old: fc.boolean(),
            terminal: fc.boolean(),
            held: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (specs) => {
          const store = new InMemoryEventStore();
          const holds = new InMemoryHoldStore();
          for (const [i, spec] of specs.entries()) {
            const runId = `run-${i}`;
            const endedAt = spec.old ? NOW - MAX_AGE - 1_000 : NOW - 10;
            await store.append(runId, 0, run(runId, endedAt, spec.terminal ? "completed" : "running"));
            if (spec.held) await holds.place(runId, "user:counsel", "litigation", NOW - 1);
          }
          const report = await applyRetention(store, holds, { maxAgeMs: MAX_AGE }, NOW);

          for (const [i, spec] of specs.entries()) {
            const runId = `run-${i}`;
            const expected = !spec.terminal
              ? "skippedActive"
              : !spec.old
                ? "skippedYoung"
                : spec.held
                  ? "skippedHeld"
                  : "deleted";
            expect(report[expected]).toContain(runId);
            expect(await store.load(runId)).toEqual(
              expected === "deleted" ? null : expect.objectContaining({ version: expect.any(Number) }),
            );
          }
          const accounted =
            report.deleted.length +
            report.skippedHeld.length +
            report.skippedActive.length +
            report.skippedYoung.length;
          expect(accounted).toBe(specs.length);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("dry run reports identically and deletes nothing", async () => {
    const store = new InMemoryEventStore();
    const holds = new InMemoryHoldStore();
    await store.append("run-old", 0, run("run-old", NOW - MAX_AGE - 5_000, "completed"));

    const dry = await applyRetention(store, holds, { maxAgeMs: MAX_AGE }, NOW, { dryRun: true });
    expect(dry.deleted).toEqual(["run-old"]);
    expect(await store.load("run-old")).not.toBeNull(); // still there

    const real = await applyRetention(store, holds, { maxAgeMs: MAX_AGE }, NOW);
    expect(real.deleted).toEqual(["run-old"]);
    expect(await store.load("run-old")).toBeNull();
  });

  it("a lifted hold makes the run eligible again; the hold history survives", async () => {
    const store = new InMemoryEventStore();
    const holds = new InMemoryHoldStore();
    await store.append("run-h", 0, run("run-h", NOW - MAX_AGE - 5_000, "completed"));
    await holds.place("run-h", "user:counsel", "subpoena 12-b", NOW - 100);

    expect((await applyRetention(store, holds, { maxAgeMs: MAX_AGE }, NOW)).skippedHeld).toEqual(["run-h"]);
    await holds.lift("run-h", "user:counsel", NOW - 50);
    expect((await applyRetention(store, holds, { maxAgeMs: MAX_AGE }, NOW)).deleted).toEqual(["run-h"]);

    const history = await holds.list();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      runId: "run-h",
      placedBy: "user:counsel",
      reason: "subpoena 12-b",
      liftedBy: "user:counsel",
    });
  });
});

function holdStoreContract(name: string, make: () => Promise<HoldStore>) {
  describe(`HoldStore contract: ${name}`, () => {
    it("one active hold per run; lifting records who and when; re-placing after lift works", async () => {
      const holds = await make();
      expect((await holds.place("r1", "user:a", "reason one", 100)).ok).toBe(true);
      expect(await holds.place("r1", "user:b", "reason two", 200)).toEqual({
        ok: false,
        error: "already_held",
      });
      expect(await holds.isHeld("r1")).toBe(true);

      expect(await holds.lift("r2", "user:a", 300)).toEqual({ ok: false, error: "not_held" });
      const lifted = await holds.lift("r1", "user:b", 300);
      expect(lifted.ok && lifted.hold).toMatchObject({ liftedBy: "user:b", liftedAt: 300 });
      expect(await holds.isHeld("r1")).toBe(false);

      expect((await holds.place("r1", "user:c", "round two", 400)).ok).toBe(true);
      expect((await holds.list()).filter((h) => h.runId === "r1")).toHaveLength(2); // history
    });
  });
}

holdStoreContract("InMemoryHoldStore", async () => new InMemoryHoldStore());

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl) {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  holdStoreContract("PostgresHoldStore", async () => {
    await pool.query("TRUNCATE legal_holds");
    return new PostgresHoldStore(pool);
  });
} else {
  console.warn(
    "[retention.test] SKIPPING PostgresHoldStore suite: TEST_DATABASE_URL is not set. CI runs this suite against a real Postgres service.",
  );
}
