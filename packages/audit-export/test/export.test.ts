import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import {
  exportRuns,
  FORMATTERS,
  GENESIS_ANCHOR,
  toNdjsonLine,
  verifyExportChain,
  type ExportRecord,
} from "@platform/audit-export";

function governedRun(runId: string, t0: number): RunEvent[] {
  let seq = 0;
  return [
    { type: "RunStarted", runId, seq: seq++, at: t0, agent: "triage@v1", principal: "user:demo", input: {} },
    { type: "ModelCalled", runId, seq: seq++, at: t0 + 10, gatewayReqId: "g1", model: "m", tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
    { type: "ToolIntentEmitted", runId, seq: seq++, at: t0 + 20, tool: "ticket.update@v1", args: { id: 7 }, risk: "write" },
    { type: "PolicyEvaluated", runId, seq: seq++, at: t0 + 30, decision: "require_approval", rule: "write-requires-approval" },
    { type: "ApprovalRequested", runId, seq: seq++, at: t0 + 40, approverGroup: "approvers", expiresAt: t0 + 100_000 },
    { type: "ApprovalGranted", runId, seq: seq++, at: t0 + 50, by: "user:omar" },
    { type: "ToolExecuted", runId, seq: seq++, at: t0 + 60, gatewayReqId: "g2", resultDigest: "sha256:aa", latencyMs: 5 },
    { type: "ModelCalled", runId, seq: seq++, at: t0 + 70, gatewayReqId: "g3", model: "m", tokensIn: 10, tokensOut: 5, costUsd: 0.01 },
    { type: "RunCompleted", runId, seq: seq++, at: t0 + 80, outcome: "done", totalCostUsd: 0.02, steps: 2 },
  ];
}

async function seededStore(): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  await store.append("run-a", 0, governedRun("run-a", 1_000_000));
  await store.append("run-b", 0, governedRun("run-b", 2_000_000));
  return store;
}

describe("tamper-evident audit export (ticket 031)", () => {
  it("a full export verifies end-to-end and is deterministic", async () => {
    const store = await seededStore();
    const first = await exportRuns(store);
    const second = await exportRuns(store);
    expect(first).toEqual(second); // same store, same stream — always
    const verified = verifyExportChain(first);
    expect(verified).toEqual({ ok: true, head: first.at(-1)!.hash, records: 18 });
  });

  it("property: any single-field tamper on any record is caught at or before that record", async () => {
    const store = await seededStore();
    const records = await exportRuns(store);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: records.length - 1 }),
        fc.constantFrom<"event" | "runId" | "hash" | "prevHash">("event", "runId", "hash", "prevHash"),
        (index, field) => {
          const tampered: ExportRecord[] = records.map((r, i) => {
            if (i !== index) return r;
            switch (field) {
              case "event":
                return { ...r, event: { ...r.event, at: r.event.at + 1 } };
              case "runId":
                return { ...r, runId: `${r.runId}-x` };
              case "hash":
                return { ...r, hash: `${r.hash.slice(0, -1)}0` === r.hash ? `${r.hash.slice(0, -1)}1` : `${r.hash.slice(0, -1)}0` };
              case "prevHash":
                return { ...r, prevHash: `${r.prevHash}x` };
            }
          });
          const verified = verifyExportChain(tampered);
          expect(verified.ok).toBe(false);
          if (!verified.ok) expect(verified.brokenAt).toBeLessThanOrEqual(records[index]!.seq + 1);
        },
      ),
    );
  });

  it("a removed middle record breaks the chain; tail truncation moves the head hash", async () => {
    const store = await seededStore();
    const records = await exportRuns(store);
    const gapped = [...records.slice(0, 5), ...records.slice(6)];
    expect(verifyExportChain(gapped)).toMatchObject({ ok: false, brokenAt: 6 });

    // truncating the tail leaves a valid chain — detection is the auditor
    // comparing the recorded head hash, which no longer matches
    const truncated = records.slice(0, -3);
    const verified = verifyExportChain(truncated);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.head).not.toBe(records.at(-1)!.hash);
  });

  it("incremental export with an anchor concatenates into ONE verifiable chain", async () => {
    const store = await seededStore();
    const full = await exportRuns(store);
    const half = 7;
    const firstBatch = full.slice(0, half);
    const headAfterFirst = firstBatch.at(-1)!.hash;
    const secondBatch = await exportRuns(store, { anchor: headAfterFirst, sinceSeq: half });
    const stitched = [...firstBatch, ...secondBatch];
    expect(stitched).toEqual(full);
    expect(verifyExportChain(stitched, GENESIS_ANCHOR).ok).toBe(true);
  });

  it("all three SIEM formats derive from identical chained records, ISO-8601 UTC", async () => {
    const store = await seededStore();
    const [record] = await exportRuns(store);
    const ndjson = JSON.parse(FORMATTERS.ndjson(record!)) as Record<string, unknown>;
    const splunk = JSON.parse(FORMATTERS.splunk(record!)) as { time: number; event: Record<string, unknown> };
    const datadog = JSON.parse(FORMATTERS.datadog(record!)) as Record<string, unknown>;

    expect(ndjson["hash"]).toBe(record!.hash);
    expect(splunk.event["hash"]).toBe(record!.hash);
    expect(datadog["hash"]).toBe(record!.hash);
    expect(ndjson["at"]).toBe("1970-01-01T00:16:40.000Z"); // epoch-ms 1_000_000, UTC
    expect(splunk.time).toBe(1_000); // HEC epoch seconds
    expect(JSON.parse(datadog["message"] as string)).toEqual(record!.event);
  });

  it("the auditor's question is answerable from the NDJSON stream alone", async () => {
    const store = await seededStore();
    const lines = (await exportRuns(store)).map(toNdjsonLine);
    const runA = lines.filter((line) => line.includes('"run-a"')).map((l) => JSON.parse(l) as { event: RunEvent });
    const started = runA.find((r) => r.event.type === "RunStarted")!.event;
    const policy = runA.find((r) => r.event.type === "PolicyEvaluated")!.event;
    const approval = runA.find((r) => r.event.type === "ApprovalGranted")!.event;
    // who / on whose behalf / under which rule / approved by — all present
    expect(started).toMatchObject({ agent: "triage@v1", principal: "user:demo" });
    expect(policy).toMatchObject({ rule: "write-requires-approval" });
    expect(approval).toMatchObject({ by: "user:omar" });
  });
});
