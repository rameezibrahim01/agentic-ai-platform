import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduce, replay, type RunState } from "@platform/core";
import { InMemoryEventStore, STORAGE_READY } from "@platform/storage";
import { describeEventStoreContract } from "@platform/storage/conformance";
// Core's test generator produces arbitrary reducer-valid runs (ticket 001);
// reused here so storage is proven against the full event vocabulary, not
// just the synthetic logs the conformance suite builds for itself.
import { arbValidRun } from "../../core/test/gen.js";

describeEventStoreContract("InMemoryEventStore", () => new InMemoryEventStore());

describe("InMemoryEventStore × core generator", () => {
  it("property: arbitrary valid runs appended in arbitrary batch splits — load ≡ incremental (replay ≡ incremental, ticket 001)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidRun(),
        fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 10 }),
        async ({ events, state }, splits) => {
          const store = new InMemoryEventStore();
          const runId = events[0]!.runId;

          let incremental: RunState | null = null;
          let version = 0;
          let cursor = 0;
          const sizes = [...splits, Number.MAX_SAFE_INTEGER];
          for (const size of sizes) {
            if (cursor >= events.length) break;
            const batch = events.slice(cursor, cursor + size);
            const result = await store.append(runId, version, batch);
            expect(result.ok).toBe(true);
            for (const event of batch) {
              const step = reduce(incremental, event);
              expect(step.ok).toBe(true);
              if (step.ok) incremental = step.state;
            }
            version += batch.length;
            cursor += batch.length;
          }

          const loaded = await store.load(runId);
          expect(loaded?.version).toBe(events.length);
          const replayed = replay(loaded?.events ?? []);
          expect(replayed.ok).toBe(true);
          if (replayed.ok) {
            expect(replayed.state).toEqual(incremental);
            expect(replayed.state).toEqual(state);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("storage readiness", () => {
  it("STORAGE_READY is flipped by ticket 002", () => {
    expect(STORAGE_READY).toBe(true);
  });
});
