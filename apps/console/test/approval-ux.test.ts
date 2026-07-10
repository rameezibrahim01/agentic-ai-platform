import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { intentPreview } from "../src/lib/preview";
import { slaState, withSla } from "../src/lib/sla";
import { groupChangesets, handleBatchDecision } from "../src/lib/changesets";
import type { PendingApprovalRow } from "../src/lib/viewmodels";

const row = (over: Partial<PendingApprovalRow>): PendingApprovalRow => ({
  runId: "r1",
  agent: "triage@v1",
  principal: "user:demo",
  tool: "ticket.update@v1",
  risk: "write",
  args: { id: 1 },
  approverGroup: "approvers",
  expiresAt: 10_000,
  requestedAt: 0,
  ...over,
});

describe("intent previews (ticket 025)", () => {
  it("update-shaped args render field-by-field as `changes.x → value`", () => {
    const preview = intentPreview({
      tool: "ticket.update@v1",
      risk: "write",
      args: { id: 4821, changes: { status: "solved", assignee: "omar" } },
    });
    expect(preview.kind).toBe("update");
    expect(preview.rows).toEqual([
      { field: "id", value: "4821" },
      { field: "changes.status", value: '→ "solved"' },
      { field: "changes.assignee", value: '→ "omar"' },
    ]);
  });

  it("flat args render per field; unknown shapes fall back to full JSON — never hidden", () => {
    const flat = intentPreview({
      tool: "notes.append@v1",
      risk: "write",
      args: { text: "hello", urgent: true, tags: ["a", "b"] },
    });
    expect(flat.kind).toBe("fields");
    expect(flat.rows).toEqual([
      { field: "text", value: '"hello"' },
      { field: "urgent", value: "true" },
      { field: "tags", value: '["a","b"]' },
    ]);

    const nested = intentPreview({
      tool: "bulk.import@v1",
      risk: "write",
      args: { plan: { steps: [{ op: "x" }] } },
    });
    expect(nested.kind).toBe("json");
    expect(nested.rows[0]!.value).toContain('"op": "x"');
  });

  it("adversarial argument content renders inert: escaped, literal, no raw control chars", () => {
    const preview = intentPreview({
      tool: "ticket.update@v1",
      risk: "write",
      args: {
        id: 1,
        changes: {
          html: "<script>alert(1)</script>",
          ansi: "\u001b[32mAPPROVED\u001b[0m",
          markdown: "**click [here](https://evil.example)**",
        },
      },
    });
    const values = preview.rows.map((r) => r.value).join("\n");
    // script tags and markdown arrive as quoted, literal text…
    expect(values).toContain('"<script>alert(1)</script>"');
    expect(values).toContain("[here](https://evil.example)");
    // …and terminal escapes are JSON-escaped, never raw
    expect(values).toContain("\\u001b[32m");
    expect(values.includes("\u001b")).toBe(false);
  });
});

describe("SLA surfacing (ticket 025)", () => {
  it("boundaries: >25% remaining is ok, <25% is expiring_soon, past expiry is pending deny", () => {
    // ttl 10_000 → threshold at remaining < 2_500
    expect(slaState(0, 10_000, 7_000)).toBe("ok"); // 3_000 left
    expect(slaState(0, 10_000, 7_500)).toBe("ok"); // exactly 25% left
    expect(slaState(0, 10_000, 7_501)).toBe("expiring_soon");
    expect(slaState(0, 10_000, 9_999)).toBe("expiring_soon");
    expect(slaState(0, 10_000, 10_000)).toBe("expired_pending_deny");
  });

  it("property: SLA state never moves backwards as time advances", () => {
    const rank = { ok: 0, expiring_soon: 1, expired_pending_deny: 2 };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (requestedAt, ttl, now1, advance) => {
          const expiresAt = requestedAt + ttl;
          const earlier = slaState(requestedAt, expiresAt, now1);
          const later = slaState(requestedAt, expiresAt, now1 + advance);
          expect(rank[later]).toBeGreaterThanOrEqual(rank[earlier]);
        },
      ),
    );
  });

  it("withSla sorts soonest-to-expire first", () => {
    const sorted = withSla(
      [row({ runId: "late", expiresAt: 30_000 }), row({ runId: "soon", expiresAt: 5_000 })],
      1_000,
    );
    expect(sorted.map((r) => r.runId)).toEqual(["soon", "late"]);
  });
});

describe("safe batching (ticket 025)", () => {
  it("groups 2+ same-kind read/write rows; irreversible NEVER batches, however similar", () => {
    const rows = [
      row({ runId: "w1" }),
      row({ runId: "w2" }),
      row({ runId: "w3", tool: "other.tool@v1" }), // different kind → single
      row({ runId: "i1", tool: "payments.refund@v1", risk: "irreversible" }),
      row({ runId: "i2", tool: "payments.refund@v1", risk: "irreversible" }),
      row({ runId: "i3", tool: "payments.refund@v1", risk: "irreversible" }),
    ];
    const { changesets, singles } = groupChangesets(rows);
    expect(changesets).toHaveLength(1);
    expect(changesets[0]).toMatchObject({ tool: "ticket.update@v1", risk: "write" });
    expect(changesets[0]!.runs.map((r) => r.runId)).toEqual(["w1", "w2"]);
    // three identical refunds stay three individual decisions:
    expect(singles.map((r) => r.runId).sort()).toEqual(["i1", "i2", "i3", "w3"]);
  });

  it("batch decision fans out one signal per run with the approver recorded", async () => {
    const signalled: [string, { granted: boolean; by: string; comment?: string }][] = [];
    const result = await handleBatchDecision(
      {
        loadPending: async () => [row({ runId: "w1" }), row({ runId: "w2" })],
        signal: async (runId, decision) => {
          signalled.push([runId, decision]);
        },
      },
      { runIds: ["w1", "w2"], decision: "approve", by: "user:omar", comment: "routine" },
    );
    expect(result.status).toBe(200);
    expect(signalled).toEqual([
      ["w1", { granted: true, by: "user:omar", comment: "routine" }],
      ["w2", { granted: true, by: "user:omar", comment: "routine" }],
    ]);
  });

  it("one over-tier run poisons the whole batch: 403, ZERO signals sent", async () => {
    let signals = 0;
    const result = await handleBatchDecision(
      {
        loadPending: async () => [
          row({ runId: "w1" }),
          row({ runId: "f1", risk: "financial" }),
        ],
        signal: async () => {
          signals += 1;
        },
      },
      { runIds: ["w1", "f1"], decision: "approve", by: "user:omar" },
    );
    expect(result.status).toBe(403);
    if (result.status === 403) expect(result.body.runIds).toEqual(["f1"]);
    expect(signals).toBe(0);
  });

  it("risk comes from the log, not the form: unknown runs 400; partial failures reported per run", async () => {
    const unknown = await handleBatchDecision(
      { loadPending: async () => [row({ runId: "w1" })], signal: async () => {} },
      { runIds: ["w1", "ghost"], decision: "deny", by: "user:omar" },
    );
    expect(unknown.status).toBe(400);

    const partial = await handleBatchDecision(
      {
        loadPending: async () => [row({ runId: "w1" }), row({ runId: "w2" })],
        signal: async (runId) => {
          if (runId === "w2") throw new Error("workflow not found");
        },
      },
      { runIds: ["w1", "w2"], decision: "deny", by: "user:omar" },
    );
    expect(partial.status).toBe(207);
    if (partial.status === 207) {
      expect(partial.body.outcomes).toEqual([
        { runId: "w1", ok: true },
        { runId: "w2", ok: false, error: "workflow not found" },
      ]);
    }
  });
});
