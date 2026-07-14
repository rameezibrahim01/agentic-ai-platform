import { describe, expect, it } from "vitest";
import { replay } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import { seedDemoRuns } from "../src/lib/seed";
import {
  formatUtc,
  pendingApprovalsView,
  runListView,
  runTimelineView,
} from "../src/lib/viewmodels";

async function seededStore() {
  const store = new InMemoryEventStore();
  await seedDemoRuns(store); // completed run with two differently-priced models + budget-failed run
  return store;
}

describe("pendingApprovalsView (ticket 018)", () => {
  it("lists exactly the runs paused awaiting approval, with the full intent", async () => {
    const store = await seededStore();
    const rows = await pendingApprovalsView(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      runId: "demo-awaiting-approval",
      agent: "support-triage@v1",
      principal: "user:demo",
      tool: "zendesk.update_ticket@v3",
      risk: "write",
      args: { id: 4821, status: "solved" },
      approverGroup: "approvers",
      expiresAt: Date.UTC(2026, 0, 15, 15, 0, 0),
      requestedAt: Date.UTC(2026, 0, 15, 11, 0, 0) + 920,
    });
  });

  it("completed and failed runs never appear in the inbox", async () => {
    const store = await seededStore();
    const rows = await pendingApprovalsView(store);
    expect(rows.map((r) => r.runId)).not.toContain("demo-completed");
    expect(rows.map((r) => r.runId)).not.toContain("demo-budget-failed");
  });
});

describe("runListView (ticket 009)", () => {
  it("rows match the reducer's state exactly", async () => {
    const store = await seededStore();
    const rows = await runListView(store);
    expect(rows.map((r) => r.runId)).toEqual([
      "demo-awaiting-approval",
      "demo-budget-failed",
      "demo-completed",
    ]);

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

describe("result previews in the timeline (ticket 063)", () => {
  it("ToolExecuted rows show the preview when present and stay unchanged without one", async () => {
    const { InMemoryEventStore } = await import("@platform/storage");
    const store = new InMemoryEventStore();
    const base = { runId: "run-preview", at: Date.UTC(2026, 0, 1) };
    await store.append("run-preview", 0, [
      { type: "RunStarted", ...base, seq: 0, agent: "a@v1", principal: "user:x", input: {} },
      {
        type: "ToolIntentEmitted", ...base, seq: 1,
        tool: "sheet.read@v1", args: { path: "x.csv" }, risk: "read",
      },
      { type: "PolicyEvaluated", ...base, seq: 2, decision: "allow", rule: "read-auto-allow" },
      {
        type: "ToolExecuted", ...base, seq: 3,
        gatewayReqId: "g1", resultDigest: "d1", latencyMs: 12,
        resultPreview: '{"rows":[["INV-1","Dune Logistics"]]}',
      },
      {
        type: "ToolIntentEmitted", ...base, seq: 4,
        tool: "notes.append@v1", args: { text: "n" }, risk: "write",
      },
      { type: "PolicyEvaluated", ...base, seq: 5, decision: "allow", rule: "dev-writes-auto" },
      // an OLD-shape event (no preview): must render exactly as before
      { type: "ToolExecuted", ...base, seq: 6, gatewayReqId: "g2", resultDigest: "d2", latencyMs: 5 },
      { type: "RunCompleted", ...base, seq: 7, outcome: "done", totalCostUsd: 0, steps: 2 },
    ]);
    const timeline = await runTimelineView(store, "run-preview");
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    const executed = timeline.rows.filter((r) => r.type === "ToolExecuted");
    expect(executed[0]!.summary).toContain("Dune Logistics"); // the evidence is visible
    expect(executed[0]!.summary).toContain("digest d1"); // integrity stays visible
    expect(executed[1]!.summary).toBe("tool executed (5ms, digest d2)"); // old shape unchanged
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

describe("escalated approvals in the inbox (ticket 048)", () => {
  it("escalatedTo is computed from the log alone", async () => {
    const store = new InMemoryEventStore();
    const base = (seq: number, at: number) => ({ runId: "run-esc-view", seq, at });
    await store.append("run-esc-view", 0, [
      { type: "RunStarted", ...base(0, 1), agent: "a@v1", principal: "user:x", input: {} },
      { type: "ModelCalled", ...base(1, 2), gatewayReqId: "g", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 },
      { type: "ToolIntentEmitted", ...base(2, 3), tool: "t.write", args: { id: 1 }, risk: "write" },
      { type: "PolicyEvaluated", ...base(3, 4), decision: "require_approval", rule: "r" },
      { type: "ApprovalRequested", ...base(4, 5), approverGroup: "approvers", expiresAt: 9_999_999 },
      { type: "ApprovalEscalated", ...base(5, 6), toGroup: "managers" },
    ]);
    const rows = await pendingApprovalsView(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run-esc-view",
      approverGroup: "approvers",
      escalatedTo: "managers",
    });
  });
});
