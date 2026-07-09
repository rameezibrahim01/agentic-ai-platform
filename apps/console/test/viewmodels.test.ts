import { describe, expect, it } from "vitest";
import { replay } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import { seedDemoRuns } from "../src/lib/seed";
import { formatUtc, runListView, runTimelineView } from "../src/lib/viewmodels";

async function seededStore() {
  const store = new InMemoryEventStore();
  await seedDemoRuns(store); // completed run with two differently-priced models + budget-failed run
  return store;
}

describe("runListView (ticket 009)", () => {
  it("rows match the reducer's state exactly", async () => {
    const store = await seededStore();
    const rows = await runListView(store);
    expect(rows.map((r) => r.runId)).toEqual(["demo-budget-failed", "demo-completed"]);

    for (const row of rows) {
      const loaded = await store.load(row.runId);
      const replayed = replay(loaded!.events);
      if (!replayed.ok) throw new Error("fixture invalid");
      const { state } = replayed;
      expect(row).toEqual({
        runId: state.runId,
        status: state.status,
        steps: state.stepCount,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        costUsd: state.costUsd,
        startedAt: state.startedAt,
      });
    }
  });
});

describe("runTimelineView", () => {
  it("shows every event in seq order with per-step tokens/cost and a correct running total", async () => {
    const store = await seededStore();
    const timeline = await runTimelineView(store, "demo-completed");
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;

    const loaded = await store.load("demo-completed");
    expect(timeline.rows.map((r) => r.seq)).toEqual(loaded!.events.map((e) => e.seq));

    // running total accumulates exactly the ModelCalled costs, in order
    let running = 0;
    for (const [i, event] of loaded!.events.entries()) {
      if (event.type === "ModelCalled") {
        running += event.costUsd;
        expect(timeline.rows[i]).toMatchObject({
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          costUsd: event.costUsd,
        });
      }
      expect(timeline.rows[i]!.runningCostUsd).toBe(running);
    }
    // final running total equals the reducer's total (includes both models/prices)
    expect(timeline.rows.at(-1)!.runningCostUsd).toBe(timeline.totals.costUsd);
    expect(timeline.status).toBe("completed");
    expect(timeline.totals.steps).toBe(2);
  });

  it("a budget-terminated run shows the failure with BudgetExceeded before RunFailed", async () => {
    const store = await seededStore();
    const timeline = await runTimelineView(store, "demo-budget-failed");
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    expect(timeline.status).toBe("failed");
    expect(timeline.outcome).toBe("LoopDetected");
    const types = timeline.rows.map((r) => r.type);
    expect(types.at(-2)).toBe("BudgetExceeded");
    expect(types.at(-1)).toBe("RunFailed");
    expect(timeline.rows.at(-1)!.summary).toContain("LoopDetected");
  });

  it("unknown run is a typed not_found, not a crash", async () => {
    const store = await seededStore();
    const timeline = await runTimelineView(store, "nope");
    expect(timeline).toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("a corrupt (unreplayable) log is a typed error, not a crash", async () => {
    const store = new InMemoryEventStore();
    // the store is deliberately dumb (ticket 002): an illegal log can be appended
    await store.append("bad", 0, [
      { type: "RunFailed", runId: "bad", seq: 0, at: 1, reason: "never started" },
    ]);
    const timeline = await runTimelineView(store, "bad");
    expect(timeline.ok).toBe(false);
    if (!timeline.ok) {
      expect(timeline.error.code).toBe("unreplayable");
    }
  });
});

describe("formatting", () => {
  it("timestamps render as ISO-8601 UTC (CLAUDE.md #1)", () => {
    expect(formatUtc(Date.UTC(2026, 0, 15, 9, 0, 0))).toBe("2026-01-15T09:00:00.000Z");
  });
});
