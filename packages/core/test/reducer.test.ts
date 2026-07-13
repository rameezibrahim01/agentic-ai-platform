import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CORE_READY,
  reduce,
  replay,
  type RunEvent,
  type RunState,
} from "@platform/core";
import { arbIllegalNext, arbValidRun } from "./gen.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("replay: valid sequences", () => {
  it("is deterministic — same events, same state, every time", () => {
    fc.assert(
      fc.property(arbValidRun(), ({ events }) => {
        const first = replay(events);
        const second = replay(events);
        expect(first.ok).toBe(true);
        expect(second).toEqual(first);
      }),
    );
  });

  it("equals folding reduce incrementally (replay ≡ incremental)", () => {
    fc.assert(
      fc.property(arbValidRun(), ({ events, state: generatedState }) => {
        let incremental: RunState | null = null;
        for (const event of events) {
          const result = reduce(incremental, event);
          expect(result.ok).toBe(true);
          if (result.ok) incremental = result.state;
        }
        const replayed = replay(events);
        expect(replayed.ok).toBe(true);
        if (replayed.ok) {
          expect(replayed.state).toEqual(incremental);
          expect(replayed.state).toEqual(generatedState);
          expect(replayed.applied).toBe(events.length);
        }
      }),
    );
  });

  it("is order-dependent — swapping any two adjacent events is rejected", () => {
    fc.assert(
      fc.property(
        arbValidRun().filter(({ events }) => events.length >= 2),
        fc.nat(),
        ({ events }, pick) => {
          const i = pick % (events.length - 1);
          const swapped = [...events];
          const a = swapped[i] as RunEvent;
          const b = swapped[i + 1] as RunEvent;
          swapped[i] = b;
          swapped[i + 1] = a;
          const result = replay(swapped);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // seq is embedded in every event, so any reorder breaks contiguity
            expect(result.reason.code).toBeTypeOf("string");
          }
        },
      ),
    );
  });
});

describe("reduce: invalid interleavings", () => {
  it("rejects with a typed reason and never mutates the input state (purity)", () => {
    fc.assert(
      fc.property(
        arbValidRun().chain(({ events, state }) =>
          arbIllegalNext(state).map((bad) => ({ events, state, bad })),
        ),
        ({ state, bad }) => {
          const snapshot = structuredClone(state);
          const frozen = deepFreeze(structuredClone(state));
          const result = reduce(frozen, bad); // frozen: any mutation throws in strict mode
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason.code).toBeTypeOf("string");
          }
          expect(frozen).toEqual(snapshot);
        },
      ),
    );
  });

  it("replay stops at the first invalid event and reports the state before rejection", () => {
    fc.assert(
      fc.property(
        arbValidRun().chain(({ events, state }) =>
          arbIllegalNext(state).map((bad) => ({ events, state, bad })),
        ),
        ({ events, state, bad }) => {
          const result = replay([...events, bad]);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.applied).toBe(events.length);
            expect(result.state).toEqual(state);
          }
        },
      ),
    );
  });
});

describe("reduce: specific illegal transitions", () => {
  const started: RunEvent = {
    type: "RunStarted",
    runId: "r1",
    seq: 0,
    at: 1_700_000_000_000,
    agent: "support-triage@v1",
    principal: "user:jane",
    input: { ticket: 42 },
  };

  function stateAfter(events: RunEvent[]): RunState {
    const result = replay(events);
    if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.reason)}`);
    return result.state;
  }

  const awaiting = stateAfter([
    started,
    { type: "ToolIntentEmitted", runId: "r1", seq: 1, at: 1, tool: "crm.update", args: {}, risk: "write" },
    { type: "PolicyEvaluated", runId: "r1", seq: 2, at: 2, decision: "require_approval", rule: "write-in-prod" },
    { type: "ApprovalRequested", runId: "r1", seq: 3, at: 3, approverGroup: "leads", expiresAt: 9 },
  ]);

  it("rejects ToolExecuted while awaiting_approval", () => {
    const result = reduce(awaiting, {
      type: "ToolExecuted",
      runId: "r1",
      seq: 4,
      at: 4,
      gatewayReqId: "g1",
      resultDigest: "d",
      latencyMs: 5,
    });
    expect(result).toEqual({
      ok: false,
      reason: {
        code: "illegal_transition",
        event: "ToolExecuted",
        status: "awaiting_approval",
        detail: "no allowed intent to execute",
      },
    });
  });

  it("rejects any event after a terminal event", () => {
    const done = stateAfter([
      started,
      { type: "RunCompleted", runId: "r1", seq: 1, at: 1, outcome: "resolved", totalCostUsd: 0, steps: 0 },
    ]);
    const result = reduce(done, {
      type: "ModelCalled",
      runId: "r1",
      seq: 2,
      at: 2,
      gatewayReqId: "g2",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0.1,
    });
    expect(result).toEqual({ ok: false, reason: { code: "run_already_terminal", status: "completed" } });
  });

  it("rejects non-contiguous seq with expected/actual", () => {
    const running = stateAfter([started]);
    const result = reduce(running, {
      type: "ModelCalled",
      runId: "r1",
      seq: 5,
      at: 2,
      gatewayReqId: "g3",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    });
    expect(result).toEqual({ ok: false, reason: { code: "non_contiguous_seq", expected: 1, actual: 5 } });
  });

  it("rejects a first event that is not RunStarted", () => {
    const result = reduce(null, {
      type: "RunFailed",
      runId: "r1",
      seq: 0,
      at: 0,
      reason: "boom",
    });
    expect(result).toEqual({
      ok: false,
      reason: { code: "first_event_must_be_run_started", got: "RunFailed" },
    });
  });

  it("only RunFailed may follow BudgetExceeded", () => {
    const overBudget = stateAfter([
      started,
      { type: "BudgetExceeded", runId: "r1", seq: 1, at: 1, reason: "MaxCostUsd" },
    ]);
    const blocked = reduce(overBudget, {
      type: "ModelCalled",
      runId: "r1",
      seq: 2,
      at: 2,
      gatewayReqId: "g4",
      model: "m",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
    expect(blocked.ok).toBe(false);
    const failed = reduce(overBudget, {
      type: "RunFailed",
      runId: "r1",
      seq: 2,
      at: 2,
      reason: "MaxCostUsd",
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) expect(failed.state.status).toBe("failed");
  });

  it("replay of an empty log is a typed rejection", () => {
    expect(replay([])).toEqual({ ok: false, reason: { code: "empty_log" }, applied: 0, state: null });
  });
});

describe("core readiness", () => {
  it("CORE_READY is flipped by ticket 001", () => {
    expect(CORE_READY).toBe(true);
  });
});

describe("approval escalation (ticket 048)", () => {
  const base = (seq: number, at: number) => ({ runId: "run-esc", seq, at });
  const toAwaiting: RunEvent[] = [
    { type: "RunStarted", ...base(0, 1), agent: "a@v1", principal: "u", input: {} },
    { type: "ModelCalled", ...base(1, 2), gatewayReqId: "g", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 },
    { type: "ToolIntentEmitted", ...base(2, 3), tool: "t.write", args: {}, risk: "write" },
    { type: "PolicyEvaluated", ...base(3, 4), decision: "require_approval", rule: "r" },
    { type: "ApprovalRequested", ...base(4, 5), approverGroup: "approvers", expiresAt: 100 },
  ];

  it("legal only while awaiting approval; records escalatedTo; the wait state otherwise unchanged", () => {
    const escalated = replay([
      ...toAwaiting,
      { type: "ApprovalEscalated", ...base(5, 6), toGroup: "managers" },
    ]);
    expect(escalated.ok).toBe(true);
    if (!escalated.ok) return;
    expect(escalated.state.status).toBe("awaiting_approval");
    expect(escalated.state.pendingApproval).toEqual({
      approverGroup: "approvers",
      expiresAt: 100,
      escalatedTo: "managers",
    });

    // a grant after escalation proceeds exactly as before
    const granted = replay([
      ...toAwaiting,
      { type: "ApprovalEscalated", ...base(5, 6), toGroup: "managers" },
      { type: "ApprovalGranted", ...base(6, 7), by: "user:mgr" },
    ]);
    expect(granted.ok && granted.state.status).toBe("running");
    expect(granted.ok && granted.state.pendingApproval).toBeNull();
  });

  it("illegal anywhere else — a misplaced escalation is a typed rejection", () => {
    const atStart = replay([
      toAwaiting[0]!,
      { type: "ApprovalEscalated", ...base(1, 2), toGroup: "managers" },
    ]);
    expect(atStart.ok).toBe(false);
    if (!atStart.ok) expect(atStart.reason).toMatchObject({ code: "illegal_transition" });
  });

  it("additive: every pre-048 log shape replays unchanged (spot pin on the approval path)", () => {
    const pre048 = replay([
      ...toAwaiting,
      { type: "ApprovalDenied", ...base(5, 6), by: "system:expiry" },
    ]);
    expect(pre048.ok && pre048.state.status).toBe("running");
    expect(pre048.ok && pre048.state.pendingApproval).toBeNull();
  });
});

describe("delegation to a person (ticket 050)", () => {
  const base = (seq: number, at: number) => ({ runId: "run-del", seq, at });
  const toAwaiting: RunEvent[] = [
    { type: "RunStarted", ...base(0, 1), agent: "a@v1", principal: "u", input: {} },
    { type: "ModelCalled", ...base(1, 2), gatewayReqId: "g", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 },
    { type: "ToolIntentEmitted", ...base(2, 3), tool: "t.write", args: {}, risk: "write" },
    { type: "PolicyEvaluated", ...base(3, 4), decision: "require_approval", rule: "r" },
    { type: "ApprovalRequested", ...base(4, 5), approverGroup: "approvers", expiresAt: 100 },
  ];

  it("legal only while awaiting; coexists with escalation; grant afterwards proceeds", () => {
    const both = replay([
      ...toAwaiting,
      { type: "ApprovalEscalated", ...base(5, 6), toGroup: "managers" },
      { type: "ApprovalDelegated", ...base(6, 7), toPrincipal: "user:omar", by: "user:lead" },
    ]);
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.state.pendingApproval).toEqual({
      approverGroup: "approvers",
      expiresAt: 100,
      escalatedTo: "managers",
      delegatedTo: "user:omar",
    });

    const granted = replay([
      ...toAwaiting,
      { type: "ApprovalDelegated", ...base(5, 6), toPrincipal: "user:omar", by: "user:lead" },
      { type: "ApprovalGranted", ...base(6, 7), by: "user:omar" },
    ]);
    expect(granted.ok && granted.state.status).toBe("running");
    expect(granted.ok && granted.state.pendingApproval).toBeNull();
  });

  it("misplaced delegation is a typed rejection", () => {
    const atStart = replay([
      toAwaiting[0]!,
      { type: "ApprovalDelegated", ...base(1, 2), toPrincipal: "user:omar", by: "user:lead" },
    ]);
    expect(atStart.ok).toBe(false);
    if (!atStart.ok) expect(atStart.reason).toMatchObject({ code: "illegal_transition" });
  });
});
