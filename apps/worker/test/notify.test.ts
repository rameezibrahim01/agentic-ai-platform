import { describe, expect, it, vi } from "vitest";
import { fakeIntent } from "@platform/model-gateway";
import { makeNotifier, notificationsConfigSchema } from "../src/notify.js";
import type { Notification } from "../src/notify.js";
import { makeWorld, runInput } from "./helpers.js";

// Ticket 051: notifications are a best-effort side channel. The log is the
// contract; a dead webhook never alters a run's course, and a deduped
// activity retry never re-notifies.

const WEBHOOK = "https://hooks.example/T000/B000/secret-token";

const okFetch = () =>
  vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NOTIFICATIONS_CONFIG (ticket 051)", () => {
  it("defaults + strictness; named-but-empty refuses; the error names the VAR, never a URL", () => {
    const parsed = notificationsConfigSchema.parse({ webhookUrlEnv: "APPROVALS_WEBHOOK_URL" });
    expect(parsed.events).toEqual([
      "approval_requested",
      "approval_escalated",
      "approval_delegated",
    ]);
    expect(parsed.timeoutMs).toBe(3_000);
    expect(notificationsConfigSchema.safeParse({ webhookUrlEnv: "X", surprise: 1 }).success).toBe(
      false,
    );

    const empty = makeNotifier({ webhookUrlEnv: "APPROVALS_WEBHOOK_URL" }, {});
    expect(empty).toMatchObject({
      ok: false,
      error: expect.stringContaining("APPROVALS_WEBHOOK_URL"),
    });
    if (!empty.ok) expect(empty.error).not.toContain("hooks.example");
  });

  it("payloads carry log-derivable facts only; the events filter is honored", async () => {
    const fetchFn = okFetch();
    const made = makeNotifier(
      { webhookUrlEnv: "HOOK", events: ["approval_requested"] },
      { HOOK: WEBHOOK },
      fetchFn,
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.summary).not.toContain(WEBHOOK); // the URL is a secret

    made.notifier({
      event: "approval_requested",
      runId: "run-1",
      agent: "a@v1",
      approverGroup: "approvers",
      expiresAt: 123,
    });
    made.notifier({ event: "approval_escalated", runId: "run-1", agent: "a@v1", toGroup: "mgrs" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1); // filter dropped the escalation
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(JSON.parse(String(init.body))).toEqual({
      event: "approval_requested",
      runId: "run-1",
      agent: "a@v1",
      approverGroup: "approvers",
      expiresAt: 123,
    });
  });

  it("failures of every kind are swallowed and never print the URL", async () => {
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    try {
      for (const fetchFn of [
        vi.fn(async () => new Response("no", { status: 500 })),
        vi.fn(async () => {
          throw new Error(`connect ECONNREFUSED ${WEBHOOK}`);
        }),
      ]) {
        const made = makeNotifier(
          { webhookUrlEnv: "HOOK" },
          { HOOK: WEBHOOK },
          fetchFn as unknown as typeof fetch,
        );
        expect(made.ok).toBe(true);
        if (!made.ok) continue;
        expect(() =>
          made.notifier({ event: "approval_escalated", runId: "r", agent: "a", toGroup: "g" }),
        ).not.toThrow();
        await flush();
      }
      expect(warns.length).toBeGreaterThanOrEqual(2);
      for (const line of warns) expect(line).not.toContain(WEBHOOK);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("activity wiring (ticket 051)", () => {
  it("approval_required notifies once; the deduped retry notifies NOTHING and the run is unaffected", async () => {
    const sent: Notification[] = [];
    const { activities } = makeWorld(
      [{ kind: "respond", result: fakeIntent({ tool: "ticket.update@v1", args: { id: 1 } }) }],
      { env: "prod", notify: (n) => sent.push(n) },
    );
    const runId = "run-notify";
    await activities.startRun({ runId, agent: runInput(runId).agent, principal: "user:x", input: {} });
    const model = await activities.callModel({
      runId,
      expectedVersion: 1,
      model: "fake-model",
      prompt: "p",
    });
    expect(model.kind).toBe("tool_intent");
    if (model.kind !== "tool_intent") return;

    const request = {
      runId,
      expectedVersion: model.version,
      agent: runInput(runId).agent,
      principal: "user:x",
      tool: model.tool,
      args: model.args,
      approverGroup: "approvers",
      approvalTtlMs: 60_000,
    };
    const first = await activities.resolveIntent(request);
    expect(first.kind).toBe("approval_required");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "approval_requested", runId, approverGroup: "approvers" });
    expect(JSON.stringify(sent[0])).not.toContain('"args"'); // facts only, never args

    // at-least-once delivery: the SAME activity call again (Temporal retry)
    const retried = await activities.resolveIntent(request);
    expect(retried.kind).toBe("approval_required");
    expect(sent).toHaveLength(1); // deduped append → no second ping

    // escalation + delegation appends notify once each, dedup likewise
    const version = (retried as { version: number }).version;
    await activities.recordEscalation({ runId, expectedVersion: version, toGroup: "mgrs", agent: "a@v1" });
    await activities.recordEscalation({ runId, expectedVersion: version, toGroup: "mgrs", agent: "a@v1" });
    await activities.recordDelegation({
      runId,
      expectedVersion: version + 1,
      toPrincipal: "user:omar",
      by: "user:lead",
      agent: "a@v1",
    });
    expect(sent.map((n) => n.event)).toEqual([
      "approval_requested",
      "approval_escalated",
      "approval_delegated",
    ]);
  });
});
