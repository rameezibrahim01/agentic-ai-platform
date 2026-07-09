import type { RunEvent } from "@platform/core";
import type { EventStore } from "@platform/storage";

// Demo data for the in-memory profile only (no DATABASE_URL): truthful,
// reducer-legal logs so the pages render something real out of the box.

function completedDemo(): RunEvent[] {
  const runId = "demo-completed";
  const t0 = Date.UTC(2026, 0, 15, 9, 0, 0);
  let seq = 0;
  return [
    { type: "RunStarted", runId, seq: seq++, at: t0, agent: "support-triage@v1", principal: "user:demo", input: { queue: "billing" } },
    { type: "ModelCalled", runId, seq: seq++, at: t0 + 900, gatewayReqId: "demo-1", model: "claude-demo", tokensIn: 3211, tokensOut: 402, costUsd: 0.0157 },
    { type: "ToolIntentEmitted", runId, seq: seq++, at: t0 + 1000, tool: "zendesk.read_ticket", args: { id: 4821 }, risk: "read" },
    { type: "PolicyEvaluated", runId, seq: seq++, at: t0 + 1010, decision: "allow", rule: "phase1-read-only-auto-allow" },
    { type: "ToolExecuted", runId, seq: seq++, at: t0 + 1400, gatewayReqId: "demo-2", resultDigest: "sha256:9a11", latencyMs: 390 },
    { type: "ModelCalled", runId, seq: seq++, at: t0 + 2600, gatewayReqId: "demo-3", model: "claude-demo-fallback", tokensIn: 4102, tokensOut: 618, costUsd: 0.0301 },
    { type: "RunCompleted", runId, seq: seq++, at: t0 + 2700, outcome: "recommended refund review for ticket 4821", totalCostUsd: 0.0458, steps: 2 },
  ];
}

function budgetFailedDemo(): RunEvent[] {
  const runId = "demo-budget-failed";
  const t0 = Date.UTC(2026, 0, 15, 10, 30, 0);
  let seq = 0;
  const events: RunEvent[] = [
    { type: "RunStarted", runId, seq: seq++, at: t0, agent: "support-triage@v1", principal: "user:demo", input: { queue: "spam" } },
  ];
  for (let step = 0; step < 3; step++) {
    events.push(
      { type: "ModelCalled", runId, seq: seq++, at: t0 + step * 1000 + 100, gatewayReqId: `demo-loop-${step}`, model: "claude-demo", tokensIn: 900, tokensOut: 120, costUsd: 0.006 },
      { type: "ToolIntentEmitted", runId, seq: seq++, at: t0 + step * 1000 + 200, tool: "crm.search", args: { q: "acme" }, risk: "read" },
      { type: "PolicyEvaluated", runId, seq: seq++, at: t0 + step * 1000 + 210, decision: "allow", rule: "phase1-read-only-auto-allow" },
      { type: "ToolExecuted", runId, seq: seq++, at: t0 + step * 1000 + 400, gatewayReqId: `demo-loop-x-${step}`, resultDigest: "sha256:0000", latencyMs: 180 },
    );
  }
  events.push(
    { type: "BudgetExceeded", runId, seq: seq++, at: t0 + 3200, reason: "LoopDetected", detail: "crm.search {q:acme} repeated 3x" },
    { type: "RunFailed", runId, seq: seq++, at: t0 + 3210, reason: "LoopDetected" },
  );
  return events;
}

export async function seedDemoRuns(store: EventStore): Promise<void> {
  for (const events of [completedDemo(), budgetFailedDemo()]) {
    const runId = events[0]!.runId;
    if ((await store.load(runId)) === null) {
      await store.append(runId, 0, events);
    }
  }
}
