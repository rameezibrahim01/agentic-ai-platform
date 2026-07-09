/**
 * Reusable EventStore conformance suite (ticket 002). Future adapters
 * (Postgres, ticket 006) import this and must pass it unchanged:
 *
 *   import { describeEventStoreContract } from "@platform/storage/conformance";
 *   describeEventStoreContract("PostgresEventStore", () => makePgStore());
 *
 * Test-only module — imports vitest/fast-check, so it is exported via a
 * dedicated subpath and never from the package root.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduce, replay } from "@platform/core";
import type { RunEvent, RunState } from "@platform/core";
import type { EventStore } from "./store.js";

/** A synthetic but reducer-valid batch: RunStarted at seq 0, then ModelCalled events. */
export function makeEvents(runId: string, fromSeq: number, count: number): RunEvent[] {
  const events: RunEvent[] = [];
  for (let i = 0; i < count; i++) {
    const seq = fromSeq + i;
    events.push(
      seq === 0
        ? {
            type: "RunStarted",
            runId,
            seq,
            at: 1_700_000_000_000,
            agent: "conformance@v1",
            principal: "user:test",
            input: {},
          }
        : {
            type: "ModelCalled",
            runId,
            seq,
            at: 1_700_000_000_000 + seq,
            gatewayReqId: `req-${seq}`,
            model: "fake-model",
            tokensIn: 10 + seq,
            tokensOut: 5 + seq,
            costUsd: 0.001 * seq,
          },
    );
  }
  return events;
}

export function describeEventStoreContract(
  name: string,
  makeStore: () => EventStore | Promise<EventStore>,
): void {
  describe(`EventStore contract: ${name}`, () => {
    it("appends to a fresh log at expectedVersion 0 and returns the new version", async () => {
      const store = await makeStore();
      const result = await store.append("run-a", 0, makeEvents("run-a", 0, 3));
      expect(result).toEqual({ ok: true, version: 3 });
      const loaded = await store.load("run-a");
      expect(loaded?.version).toBe(3);
      expect(loaded?.events).toHaveLength(3);
    });

    it("load returns null for an unknown run", async () => {
      const store = await makeStore();
      expect(await store.load("nope")).toBeNull();
    });

    it("rejects a stale expectedVersion with actualVersion; retry with it succeeds", async () => {
      const store = await makeStore();
      await store.append("run-a", 0, makeEvents("run-a", 0, 2));
      const stale = await store.append("run-a", 0, makeEvents("run-a", 0, 1));
      expect(stale).toEqual({ ok: false, conflict: { actualVersion: 2 } });
      if (!stale.ok) {
        const retry = await store.append(
          "run-a",
          stale.conflict.actualVersion,
          makeEvents("run-a", stale.conflict.actualVersion, 1),
        );
        expect(retry).toEqual({ ok: true, version: 3 });
      }
    });

    it("a failed append writes nothing", async () => {
      const store = await makeStore();
      await store.append("run-a", 0, makeEvents("run-a", 0, 2));
      await store.append("run-a", 5, makeEvents("run-a", 5, 3));
      const loaded = await store.load("run-a");
      expect(loaded?.version).toBe(2);
      expect(replay(loaded?.events ?? []).ok).toBe(true);
    });

    it("returned events are copies — mutating them does not corrupt the store", async () => {
      const store = await makeStore();
      await store.append("run-a", 0, makeEvents("run-a", 0, 2));
      const first = await store.load("run-a");
      first!.events.pop();
      (first!.events[0] as { runId: string }).runId = "tampered";
      const second = await store.load("run-a");
      expect(second?.version).toBe(2);
      expect(second?.events[0]?.runId).toBe("run-a");
    });

    it("exactly one same-version racer wins; the rest conflict with actualVersion", async () => {
      const store = await makeStore();
      await store.append("run-a", 0, makeEvents("run-a", 0, 1));
      const racers = await Promise.all(
        [0, 1, 2, 3].map(() => store.append("run-a", 1, makeEvents("run-a", 1, 1))),
      );
      const wins = racers.filter((r) => r.ok);
      const losses = racers.filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(3);
      for (const loss of losses) {
        if (!loss.ok) expect(loss.conflict.actualVersion).toBe(2);
      }
      expect((await store.load("run-a"))?.version).toBe(2);
    });

    it("property: N interleaved retrying writers — contiguous seq, no torn writes", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 2, maxLength: 6 }),
          async (batchSizes) => {
            const store = await makeStore();
            const runId = "run-race";
            const writeWithRetry = async (batchSize: number) => {
              for (;;) {
                const version = (await store.load(runId))?.version ?? 0;
                const result = await store.append(
                  runId,
                  version,
                  makeEvents(runId, version, batchSize),
                );
                if (result.ok) return;
                // conflict must always report the true version
                const actual = (await store.load(runId))?.version ?? 0;
                expect(result.conflict.actualVersion).toBeLessThanOrEqual(actual);
              }
            };
            await Promise.all(batchSizes.map((size) => writeWithRetry(size)));

            const loaded = await store.load(runId);
            const total = batchSizes.reduce((a, b) => a + b, 0);
            expect(loaded?.version).toBe(total);
            loaded?.events.forEach((event, i) => expect(event.seq).toBe(i));
            expect(replay(loaded?.events ?? []).ok).toBe(true);
          },
        ),
        { numRuns: 25 },
      );
    });

    it("property: load after arbitrary append history ≡ incremental reduction", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 8 }),
          async (batchSizes) => {
            const store = await makeStore();
            const runId = "run-history";
            let incremental: RunState | null = null;
            let version = 0;
            for (const size of batchSizes) {
              const batch = makeEvents(runId, version, size);
              const result = await store.append(runId, version, batch);
              expect(result.ok).toBe(true);
              for (const event of batch) {
                const step = reduce(incremental, event);
                expect(step.ok).toBe(true);
                if (step.ok) incremental = step.state;
              }
              version += size;
            }
            const loaded = await store.load(runId);
            const replayed = replay(loaded?.events ?? []);
            expect(replayed.ok).toBe(true);
            if (replayed.ok) expect(replayed.state).toEqual(incremental);
          },
        ),
        { numRuns: 25 },
      );
    });

    it("listRuns derives status, steps, and cost via core's replay", async () => {
      const store = await makeStore();
      await store.append("run-1", 0, makeEvents("run-1", 0, 3)); // running, 2 model calls
      const completed: RunEvent[] = [
        ...makeEvents("run-2", 0, 2),
        {
          type: "RunCompleted",
          runId: "run-2",
          seq: 2,
          at: 1_700_000_000_002,
          outcome: "done",
          totalCostUsd: 0.001,
          steps: 1,
        },
      ];
      await store.append("run-2", 0, completed);

      const all = await store.listRuns();
      expect(all.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
      const run1 = all.find((r) => r.runId === "run-1");
      expect(run1).toMatchObject({ status: "running", steps: 2, version: 3 });
      expect(run1?.costUsd).toBeCloseTo(0.001 + 0.002, 10);
      expect(all.find((r) => r.runId === "run-2")).toMatchObject({
        status: "completed",
        steps: 1,
        version: 3,
      });

      const onlyCompleted = await store.listRuns({ status: "completed" });
      expect(onlyCompleted.map((r) => r.runId)).toEqual(["run-2"]);
    });
  });
}
