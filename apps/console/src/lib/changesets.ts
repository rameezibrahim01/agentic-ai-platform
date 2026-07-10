import type { PendingApprovalRow } from "./viewmodels.js";

// Safe batching (ticket 025): ten identical low-risk writes should not cost
// ten identical clicks — that trains approvers to stop reading. But batching
// is offered ONLY for read/write tiers; irreversible and financial intents
// stay one-by-one BY CONSTRUCTION (the Changeset type cannot carry them).
// A batch decision fans out to one signal per run, so the audit trail stays
// per-run — there is no "bulk approved" event to hide behind.

export type BatchableRisk = "read" | "write";

const BATCHABLE: readonly string[] = ["read", "write"];

export interface Changeset<R extends PendingApprovalRow = PendingApprovalRow> {
  /** agent + tool + risk — "the same kind of change, again". */
  key: string;
  agent: string;
  tool: string;
  risk: BatchableRisk;
  runs: R[];
}

export interface GroupedApprovals<R extends PendingApprovalRow = PendingApprovalRow> {
  /** Two or more read/write intents of the same kind. */
  changesets: Changeset<R>[];
  /** Everything else — including EVERY irreversible/financial intent. */
  singles: R[];
}

export function groupChangesets<R extends PendingApprovalRow>(
  rows: readonly R[],
): GroupedApprovals<R> {
  const byKey = new Map<string, R[]>();
  const singles: R[] = [];
  for (const row of rows) {
    if (!BATCHABLE.includes(row.risk)) {
      singles.push(row); // never batchable, regardless of how many look alike
      continue;
    }
    const key = `${row.agent}|${row.tool}|${row.risk}`;
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }
  const changesets: Changeset<R>[] = [];
  for (const [key, runs] of byKey) {
    if (runs.length < 2) {
      singles.push(...runs);
      continue;
    }
    const first = runs[0]!;
    changesets.push({ key, agent: first.agent, tool: first.tool, risk: first.risk as BatchableRisk, runs });
  }
  return { changesets, singles };
}

export interface BatchDecisionRequest {
  runIds: readonly string[];
  decision: "approve" | "deny";
  by: string;
  comment?: string;
}

export interface BatchRunOutcome {
  runId: string;
  ok: boolean;
  error?: string;
}

export interface BatchDeps {
  /** The CURRENT pending rows — risk is recomputed here, never trusted from the form. */
  loadPending(): Promise<PendingApprovalRow[]>;
  signal(
    runId: string,
    decision: { granted: boolean; by: string; comment?: string },
  ): Promise<void>;
}

export type BatchDecisionResult =
  | { status: 200; body: { ok: true; outcomes: BatchRunOutcome[] } }
  | { status: 207; body: { ok: false; outcomes: BatchRunOutcome[] } }
  | { status: 400 | 403; body: { ok: false; error: string; runIds?: string[] } };

/** Decide a changeset: ceiling enforced server-side, one signal per run. */
export async function handleBatchDecision(
  deps: BatchDeps,
  request: BatchDecisionRequest,
): Promise<BatchDecisionResult> {
  if (request.runIds.length === 0) {
    return { status: 400, body: { ok: false, error: "no runIds given" } };
  }
  const pending = new Map((await deps.loadPending()).map((row) => [row.runId, row]));

  const unknown = request.runIds.filter((runId) => !pending.has(runId));
  if (unknown.length > 0) {
    return {
      status: 400,
      body: { ok: false, error: "not pending approval", runIds: unknown },
    };
  }
  const overTier = request.runIds.filter(
    (runId) => !BATCHABLE.includes(pending.get(runId)!.risk),
  );
  if (overTier.length > 0) {
    // one over-tier intent poisons the WHOLE batch: nothing is signalled
    return {
      status: 403,
      body: {
        ok: false,
        error: "irreversible/financial intents are never batchable — decide them one by one",
        runIds: overTier,
      },
    };
  }

  const outcomes: BatchRunOutcome[] = [];
  for (const runId of request.runIds) {
    try {
      await deps.signal(runId, {
        granted: request.decision === "approve",
        by: request.by,
        ...(request.comment !== undefined && request.comment !== ""
          ? { comment: request.comment }
          : {}),
      });
      outcomes.push({ runId, ok: true });
    } catch (error) {
      outcomes.push({
        runId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const allOk = outcomes.every((o) => o.ok);
  return allOk
    ? { status: 200, body: { ok: true, outcomes } }
    : { status: 207, body: { ok: false, outcomes } };
}
