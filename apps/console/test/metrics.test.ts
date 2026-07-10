import { describe, expect, it } from "vitest";
import { replay } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import type { RunScore } from "@platform/storage";
import { seedDemoRuns } from "../src/lib/seed";
import { costsView, driftAlarms } from "../src/lib/metrics";

// Ticket 029: cost-per-outcome must equal the reducer's totals exactly —
// the dashboard is a view of the log, never parallel bookkeeping.

const score = (runId: string, weightedScore: number): RunScore => ({
  runId,
  agent: "support-triage@v1",
  rubricId: "quality@v1",
  judgeModel: "judge-pinned",
  scores: { resolution: weightedScore },
  weightedScore,
  scoredAt: 1,
});

describe("costsView (ticket 029)", () => {
  it("per-agent rows match the reducer's totals exactly; cost-per-outcome = total/completed", async () => {
    const store = new InMemoryEventStore();
    await seedDemoRuns(store); // 3 runs for support-triage@v1: completed, budget-failed, awaiting

    const rows = await costsView(store, []);
    const triage = rows.find((r) => r.agent === "support-triage@v1")!;
    expect(triage.runs).toBe(3);
    expect(triage.completed).toBe(1);

    // pin against the reducer, not hand-computed constants
    let expectedTotal = 0;
    for (const summary of await store.listRuns()) {
      const replayed = replay((await store.load(summary.runId))!.events);
      if (replayed.ok) expectedTotal += replayed.state.costUsd;
    }
    expect(triage.totalCostUsd).toBeCloseTo(expectedTotal, 10);
    expect(triage.costPerOutcomeUsd).toBeCloseTo(expectedTotal / 1, 10);
    expect(triage.meanScore).toBeNull(); // unsampled is unsampled, never faked
    expect(triage.budgetKillRate).toBeCloseTo(1 / 3);
  });

  it("judge scores average only over sampled runs; drift alarms fire on injected thresholds", async () => {
    const store = new InMemoryEventStore();
    await seedDemoRuns(store);
    const rows = await costsView(store, [score("demo-completed", 2)]);
    const triage = rows.find((r) => r.agent === "support-triage@v1")!;
    expect(triage.meanScore).toBe(2);

    const alarms = driftAlarms(rows, {
      maxToolFailureRate: 0.5,
      maxRefusalRate: 10,
      maxBudgetKillRate: 0.25, // triage is at 1/3 — must alarm
      minMeanScore: 3, // sampled mean 2 — must alarm
    });
    expect(alarms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "support-triage@v1", metric: "budget_kill_rate" }),
        expect.objectContaining({ agent: "support-triage@v1", metric: "mean_score", value: 2 }),
      ]),
    );
    expect(alarms).toHaveLength(2);
  });
});
