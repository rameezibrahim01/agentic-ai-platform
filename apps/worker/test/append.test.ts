import { describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import { idempotentAppend } from "../src/append.js";

const started: RunEvent = {
  type: "RunStarted",
  runId: "r1",
  seq: 0,
  at: 1_700_000_000_000,
  agent: "a@v1",
  principal: "user:t",
  input: {},
};

describe("idempotentAppend — key (runId, seq)", () => {
  it("appends once, dedupes the redelivery", async () => {
    const store = new InMemoryEventStore();
    const first = await idempotentAppend(store, "r1", 0, [started]);
    expect(first).toEqual({ ok: true, version: 1, deduped: false });

    const redelivered = await idempotentAppend(store, "r1", 0, [started]);
    expect(redelivered).toEqual({ ok: true, version: 1, deduped: true });

    expect((await store.load("r1"))?.version).toBe(1);
  });

  it("a genuine conflict (different events at the same seq) is an error, not a dedupe", async () => {
    const store = new InMemoryEventStore();
    await idempotentAppend(store, "r1", 0, [started]);
    const conflicting = await idempotentAppend(store, "r1", 0, [
      { type: "RunFailed", runId: "r1", seq: 0, at: 1, reason: "impostor" },
    ]);
    expect(conflicting.ok).toBe(false);
    expect((await store.load("r1"))?.version).toBe(1);
  });
});
