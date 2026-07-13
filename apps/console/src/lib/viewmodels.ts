import { replay } from "@platform/core";
import type { ReplayRejection, RunEvent, RunStatus } from "@platform/core";
import type { EventStore } from "@platform/storage";

// Pure view models — the truthfulness of the console lives here, fully
// unit-tested. Pages only render what these return (ticket 009).

export interface RunListRow {
  runId: string;
  status: RunStatus;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
}

export interface TimelineRow {
  seq: number;
  at: number;
  type: RunEvent["type"];
  summary: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /** Cost accumulated up to and including this event. */
  runningCostUsd: number;
}

export type RunTimeline =
  | {
      ok: true;
      runId: string;
      status: RunStatus;
      outcome: string;
      agent: string;
      principal: string;
      startedAt: number;
      totals: { steps: number; tokensIn: number; tokensOut: number; costUsd: number };
      rows: TimelineRow[];
    }
  | { ok: false; error: { code: "not_found" } | { code: "unreplayable"; reason: ReplayRejection } };

function summarize(event: RunEvent): string {
  switch (event.type) {
    case "RunStarted":
      return `run started — agent ${event.agent}, principal ${event.principal}`;
    case "ModelCalled":
      return `model ${event.model} called (${event.tokensIn} in / ${event.tokensOut} out tokens)`;
    case "ToolIntentEmitted":
      return `intent emitted: ${event.tool} [${event.risk}]`;
    case "PolicyEvaluated":
      return `policy ${event.decision} (rule: ${event.rule})`;
    case "ApprovalRequested":
      return `approval requested from ${event.approverGroup}`;
    case "ApprovalEscalated":
      return `approval escalated to ${event.toGroup} (original expiry stands)`;
    case "ApprovalGranted":
      return `approved by ${event.by}`;
    case "ApprovalDenied":
      return `denied by ${event.by}`;
    case "ToolExecuted":
      return `tool executed (${event.latencyMs}ms, digest ${event.resultDigest})`;
    case "ToolFailed":
      return `tool failed: ${event.error}`;
    case "BudgetExceeded":
      return `budget exceeded: ${event.reason}${event.detail ? ` — ${event.detail}` : ""}`;
    case "RunCompleted":
      return `completed: ${event.outcome}`;
    case "RunFailed":
      return `failed: ${event.reason}`;
    default: {
      event satisfies never;
      return "unknown event";
    }
  }
}

export async function runListView(store: EventStore): Promise<RunListRow[]> {
  const summaries = await store.listRuns();
  const rows: RunListRow[] = [];
  for (const summary of summaries) {
    const loaded = await store.load(summary.runId);
    if (!loaded) continue;
    const replayed = replay(loaded.events);
    if (!replayed.ok) continue;
    const { state } = replayed;
    rows.push({
      runId: state.runId,
      status: state.status,
      steps: state.stepCount,
      tokensIn: state.tokensIn,
      tokensOut: state.tokensOut,
      costUsd: state.costUsd,
      startedAt: state.startedAt,
    });
  }
  return rows;
}

export async function runTimelineView(store: EventStore, runId: string): Promise<RunTimeline> {
  const loaded = await store.load(runId);
  if (loaded === null) return { ok: false, error: { code: "not_found" } };
  const replayed = replay(loaded.events);
  if (!replayed.ok) {
    return { ok: false, error: { code: "unreplayable", reason: replayed.reason } };
  }
  const { state } = replayed;

  let runningCostUsd = 0;
  const rows: TimelineRow[] = loaded.events.map((event) => {
    if (event.type === "ModelCalled") runningCostUsd += event.costUsd;
    return {
      seq: event.seq,
      at: event.at,
      type: event.type,
      summary: summarize(event),
      ...(event.type === "ModelCalled"
        ? { tokensIn: event.tokensIn, tokensOut: event.tokensOut, costUsd: event.costUsd }
        : {}),
      runningCostUsd,
    };
  });

  return {
    ok: true,
    runId: state.runId,
    status: state.status,
    outcome:
      state.outcome === null
        ? state.status
        : state.outcome.kind === "completed"
          ? state.outcome.outcome
          : state.outcome.reason,
    agent: state.agent,
    principal: state.principal,
    startedAt: state.startedAt,
    totals: {
      steps: state.stepCount,
      tokensIn: state.tokensIn,
      tokensOut: state.tokensOut,
      costUsd: state.costUsd,
    },
    rows,
  };
}

export interface PendingApprovalRow {
  runId: string;
  agent: string;
  principal: string;
  tool: string;
  risk: string;
  args: Readonly<Record<string, unknown>>;
  approverGroup: string;
  expiresAt: number;
  requestedAt: number;
  /** Ticket 048: the fallback group the request escalated to, from the log. */
  escalatedTo?: string;
}

/** Runs paused awaiting a human — the inbox's rows, straight from the log (ticket 018). */
export async function pendingApprovalsView(store: EventStore): Promise<PendingApprovalRow[]> {
  const summaries = await store.listRuns({ status: "awaiting_approval" });
  const rows: PendingApprovalRow[] = [];
  for (const summary of summaries) {
    const loaded = await store.load(summary.runId);
    if (!loaded) continue;
    const replayed = replay(loaded.events);
    if (!replayed.ok) continue;
    const { state } = replayed;
    if (state.status !== "awaiting_approval" || !state.pendingIntent || !state.pendingApproval) {
      continue;
    }
    const requested = loaded.events.findLast((e) => e.type === "ApprovalRequested");
    rows.push({
      runId: state.runId,
      agent: state.agent,
      principal: state.principal,
      tool: state.pendingIntent.tool,
      risk: state.pendingIntent.risk,
      args: state.pendingIntent.args,
      approverGroup: state.pendingApproval.approverGroup,
      expiresAt: state.pendingApproval.expiresAt,
      requestedAt: requested?.at ?? state.startedAt,
      // escalation is computed from the LOG (048), never trusted from a form
      ...(state.pendingApproval.escalatedTo !== undefined
        ? { escalatedTo: state.pendingApproval.escalatedTo }
        : {}),
    });
  }
  return rows;
}

/** All times are epoch-ms UTC in code; ISO-8601 UTC for display (CLAUDE.md #1). */
export function formatUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function formatUsd(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}
