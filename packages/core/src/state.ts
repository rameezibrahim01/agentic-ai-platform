import type { RiskTier, RunEvent, RunEventType } from "./events.js";

export type RunStatus = "running" | "awaiting_approval" | "completed" | "failed";

/** A tool intent the model has emitted but the run has not yet resolved. */
export interface PendingIntent {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly risk: RiskTier;
  /**
   * null       — awaiting PolicyEvaluated
   * "allow"    — cleared for ToolExecuted/ToolFailed (directly or via ApprovalGranted)
   * "require_approval" — awaiting ApprovalRequested
   * (a "deny" decision clears the pending intent instead of being stored)
   */
  readonly decision: "allow" | "require_approval" | null;
}

export interface PendingApproval {
  readonly approverGroup: string;
  readonly expiresAt: number;
  /** Set when the request escalated to a fallback group (ticket 048). */
  readonly escalatedTo?: string;
}

export type RunOutcome =
  | { readonly kind: "completed"; readonly outcome: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface RunState {
  readonly runId: string;
  /** seq of the last applied event; the next event must carry seq + 1. */
  readonly seq: number;
  readonly status: RunStatus;
  readonly agent: string;
  readonly principal: string;
  readonly startedAt: number;
  /** Model calls so far — the run's step count. */
  readonly stepCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly pendingIntent: PendingIntent | null;
  readonly pendingApproval: PendingApproval | null;
  /** Once set, only RunFailed may follow (ticket 005 enforces at the engine). */
  readonly budgetExceeded: { readonly reason: string } | null;
  readonly outcome: RunOutcome | null;
}

export type Rejection =
  | { code: "first_event_must_be_run_started"; got: RunEventType }
  | { code: "already_started"; got: "RunStarted" }
  | { code: "run_id_mismatch"; expected: string; actual: string }
  | { code: "non_contiguous_seq"; expected: number; actual: number }
  | { code: "run_already_terminal"; status: "completed" | "failed" }
  | { code: "illegal_transition"; event: RunEventType; status: RunStatus; detail: string };

export type ReduceResult =
  | { ok: true; state: RunState }
  | { ok: false; reason: Rejection };

export type ReplayRejection = Rejection | { code: "empty_log" };

export type ReplayResult =
  | { ok: true; state: RunState; applied: number }
  | { ok: false; reason: ReplayRejection; applied: number; state: RunState | null };

const ok = (state: RunState): ReduceResult => ({ ok: true, state });
const reject = (reason: Rejection): ReduceResult => ({ ok: false, reason });

const illegal = (
  event: RunEventType,
  status: RunStatus,
  detail: string,
): ReduceResult => reject({ code: "illegal_transition", event, status, detail });

/**
 * Pure state transition: no clock, no I/O, no randomness, never mutates `state`.
 * Illegal transitions return a typed rejection — never throw across the boundary.
 */
export function reduce(state: RunState | null, event: RunEvent): ReduceResult {
  if (state === null) {
    if (event.type !== "RunStarted") {
      return reject({ code: "first_event_must_be_run_started", got: event.type });
    }
    if (event.seq !== 0) {
      return reject({ code: "non_contiguous_seq", expected: 0, actual: event.seq });
    }
    return ok({
      runId: event.runId,
      seq: 0,
      status: "running",
      agent: event.agent,
      principal: event.principal,
      startedAt: event.at,
      stepCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      pendingIntent: null,
      pendingApproval: null,
      budgetExceeded: null,
      outcome: null,
    });
  }

  if (event.type === "RunStarted") {
    return reject({ code: "already_started", got: event.type });
  }
  if (event.runId !== state.runId) {
    return reject({ code: "run_id_mismatch", expected: state.runId, actual: event.runId });
  }
  if (event.seq !== state.seq + 1) {
    return reject({ code: "non_contiguous_seq", expected: state.seq + 1, actual: event.seq });
  }
  if (state.status === "completed" || state.status === "failed") {
    return reject({ code: "run_already_terminal", status: state.status });
  }
  if (state.budgetExceeded !== null && event.type !== "RunFailed") {
    return illegal(event.type, state.status, "only RunFailed may follow BudgetExceeded");
  }

  switch (event.type) {
    case "ModelCalled": {
      if (state.status !== "running") {
        return illegal(event.type, state.status, "model may only be called while running");
      }
      if (state.pendingIntent !== null) {
        return illegal(event.type, state.status, "a tool intent is pending resolution");
      }
      return ok({
        ...state,
        seq: event.seq,
        stepCount: state.stepCount + 1,
        tokensIn: state.tokensIn + event.tokensIn,
        tokensOut: state.tokensOut + event.tokensOut,
        costUsd: state.costUsd + event.costUsd,
      });
    }

    case "ToolIntentEmitted": {
      if (state.status !== "running") {
        return illegal(event.type, state.status, "intents may only be emitted while running");
      }
      if (state.pendingIntent !== null) {
        return illegal(event.type, state.status, "a tool intent is already pending");
      }
      return ok({
        ...state,
        seq: event.seq,
        pendingIntent: { tool: event.tool, args: event.args, risk: event.risk, decision: null },
      });
    }

    case "PolicyEvaluated": {
      if (state.status !== "running" || state.pendingIntent === null) {
        return illegal(event.type, state.status, "no pending intent to evaluate");
      }
      if (state.pendingIntent.decision !== null) {
        return illegal(event.type, state.status, "pending intent already has a policy decision");
      }
      if (event.decision === "deny") {
        return ok({ ...state, seq: event.seq, pendingIntent: null });
      }
      return ok({
        ...state,
        seq: event.seq,
        pendingIntent: { ...state.pendingIntent, decision: event.decision },
      });
    }

    case "ApprovalRequested": {
      if (
        state.status !== "running" ||
        state.pendingIntent === null ||
        state.pendingIntent.decision !== "require_approval"
      ) {
        return illegal(event.type, state.status, "no intent awaiting approval request");
      }
      return ok({
        ...state,
        seq: event.seq,
        status: "awaiting_approval",
        pendingApproval: { approverGroup: event.approverGroup, expiresAt: event.expiresAt },
      });
    }

    case "ApprovalEscalated": {
      if (state.status !== "awaiting_approval" || state.pendingApproval === null) {
        return illegal(event.type, state.status, "no approval is pending to escalate");
      }
      return ok({
        ...state,
        seq: event.seq,
        pendingApproval: { ...state.pendingApproval, escalatedTo: event.toGroup },
      });
    }

    case "ApprovalGranted": {
      if (state.status !== "awaiting_approval" || state.pendingIntent === null) {
        return illegal(event.type, state.status, "no approval is pending");
      }
      return ok({
        ...state,
        seq: event.seq,
        status: "running",
        pendingApproval: null,
        pendingIntent: { ...state.pendingIntent, decision: "allow" },
      });
    }

    case "ApprovalDenied": {
      if (state.status !== "awaiting_approval") {
        return illegal(event.type, state.status, "no approval is pending");
      }
      return ok({
        ...state,
        seq: event.seq,
        status: "running",
        pendingApproval: null,
        pendingIntent: null,
      });
    }

    case "ToolExecuted":
    case "ToolFailed": {
      if (
        state.status !== "running" ||
        state.pendingIntent === null ||
        state.pendingIntent.decision !== "allow"
      ) {
        return illegal(event.type, state.status, "no allowed intent to execute");
      }
      return ok({ ...state, seq: event.seq, pendingIntent: null });
    }

    case "BudgetExceeded": {
      return ok({ ...state, seq: event.seq, budgetExceeded: { reason: event.reason } });
    }

    case "RunCompleted": {
      if (state.status !== "running") {
        return illegal(event.type, state.status, "only a running run may complete");
      }
      if (state.pendingIntent !== null || state.pendingApproval !== null) {
        return illegal(event.type, state.status, "cannot complete with pending intent/approval");
      }
      return ok({
        ...state,
        seq: event.seq,
        status: "completed",
        outcome: { kind: "completed", outcome: event.outcome },
      });
    }

    case "RunFailed": {
      return ok({
        ...state,
        seq: event.seq,
        status: "failed",
        pendingIntent: null,
        pendingApproval: null,
        outcome: { kind: "failed", reason: event.reason },
      });
    }

    default: {
      // Exhaustiveness: adding an event type without handling it is a compile error.
      event satisfies never;
      return illegal(
        (event as RunEvent).type,
        state.status,
        "unhandled event type",
      );
    }
  }
}

/** Fold a full log through `reduce`. Pure and deterministic: same events, same state. */
export function replay(events: readonly RunEvent[]): ReplayResult {
  if (events.length === 0) {
    return { ok: false, reason: { code: "empty_log" }, applied: 0, state: null };
  }
  let state: RunState | null = null;
  let applied = 0;
  for (const event of events) {
    const result = reduce(state, event);
    if (!result.ok) {
      return { ok: false, reason: result.reason, applied, state };
    }
    state = result.state;
    applied += 1;
  }
  // state is non-null here: events was non-empty and every reduce succeeded.
  return { ok: true, state: state as RunState, applied };
}
