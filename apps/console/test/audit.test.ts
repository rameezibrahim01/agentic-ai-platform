import { describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import { seedDemoRuns } from "../src/lib/seed";
import { auditorsAnswer, renderAuditorsAnswer } from "../src/lib/audit";

// The auditor's question (Phase 2 exit drill 6): one call answers
// who / what / when / on-whose-behalf / under-which-rule from the log alone.

/** A run whose write went through a human: the full approval audit shape. */
function approvedWriteRun(): RunEvent[] {
  const runId = "audit-approved-write";
  const t0 = Date.UTC(2026, 5, 1, 2, 0, 0); // a 2 a.m. run, fittingly
  let seq = 0;
  return [
    { type: "RunStarted", runId, seq: seq++, at: t0, agent: "nightly-triage@v1", principal: "user:oncall", input: {} },
    { type: "ModelCalled", runId, seq: seq++, at: t0 + 100, gatewayReqId: "g1", model: "m", tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
    { type: "ToolIntentEmitted", runId, seq: seq++, at: t0 + 200, tool: "ticket.update@v1", args: { id: 7 }, risk: "write" },
    { type: "PolicyEvaluated", runId, seq: seq++, at: t0 + 210, decision: "require_approval", rule: "write-requires-approval" },
    { type: "ApprovalRequested", runId, seq: seq++, at: t0 + 220, approverGroup: "approvers", expiresAt: t0 + 3_600_000 },
    { type: "ApprovalGranted", runId, seq: seq++, at: t0 + 500, by: "user:omar", comment: "verified" },
    { type: "ToolExecuted", runId, seq: seq++, at: t0 + 600, gatewayReqId: "g2", resultDigest: "sha256:aa", latencyMs: 20 },
    { type: "ModelCalled", runId, seq: seq++, at: t0 + 700, gatewayReqId: "g3", model: "m", tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
    { type: "RunCompleted", runId, seq: seq++, at: t0 + 800, outcome: "done", totalCostUsd: 0.02, steps: 2 },
  ];
}

describe("the auditor's question (ticket 022)", () => {
  it("answers who/what/when/on-whose-behalf/under-which-rule for a completed run", async () => {
    const store = new InMemoryEventStore();
    await seedDemoRuns(store);
    const result = await auditorsAnswer(store, "demo-completed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.answer).toMatchObject({
      runId: "demo-completed",
      agent: "support-triage@v1", // who
      principal: "user:demo", // on whose behalf
      status: "completed",
    });
    expect(result.answer.startedAt).toMatch(/Z$/); // when, ISO-8601 UTC
    expect(result.answer.actions).toHaveLength(1);
    expect(result.answer.actions[0]).toMatchObject({
      tool: "zendesk.read_ticket", // what
      risk: "read",
      decision: "allow",
      rule: "phase1-read-only-auto-allow", // under which rule
      outcome: "executed",
    });

    const rendered = renderAuditorsAnswer(result.answer);
    console.log(`\n${rendered}\n`); // the drill's printed answer
    for (const dimension of ["who acted:", "on whose behalf:", "when:", "under rule:"]) {
      expect(rendered).toContain(dimension);
    }
  });

  it("a human-approved write names the approver alongside the rule", async () => {
    const store = new InMemoryEventStore();
    const events = approvedWriteRun();
    await store.append(events[0]!.runId, 0, events);

    const result = await auditorsAnswer(store, "audit-approved-write");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer.actions[0]).toMatchObject({
      tool: "ticket.update@v1",
      risk: "write",
      decision: "require_approval",
      rule: "write-requires-approval",
      approvedBy: "user:omar",
      outcome: "executed",
    });
    expect(result.answer.actions[0]!.executedAt).toMatch(/Z$/);
    expect(renderAuditorsAnswer(result.answer)).toContain("approved by:   user:omar");
  });

  it("a pending approval and an unknown run are both typed, honest answers", async () => {
    const store = new InMemoryEventStore();
    await seedDemoRuns(store);

    const pending = await auditorsAnswer(store, "demo-awaiting-approval");
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.answer.status).toBe("awaiting_approval");
      expect(pending.answer.actions[0]).toMatchObject({
        tool: "zendesk.update_ticket@v3",
        rule: "write-requires-approval",
        outcome: "pending",
      });
    }

    expect(await auditorsAnswer(store, "ghost-run")).toEqual({ ok: false, error: "not_found" });
  });
});
