import { replay } from "@platform/core";
import type { EventStore } from "@platform/storage";
import { formatUtc } from "./viewmodels.js";

// The auditor's question (ticket 022, Phase 2 exit drill 6): for a given run
// id, reconstruct who acted, what they did, when, on whose behalf, and under
// which rule — entirely from the event log. If the log can't answer this in
// one call, the audit story is broken; this module IS the executable form of
// that guarantee.

export interface AuditedAction {
  /** what */
  tool: string;
  risk: string;
  args: Readonly<Record<string, unknown>>;
  /** when (ISO-8601 UTC) */
  intentAt: string;
  /** under which rule */
  decision?: string;
  rule?: string;
  /** the human in the loop, when there was one */
  approvedBy?: string;
  deniedBy?: string;
  outcome: "executed" | "refused" | "failed" | "pending";
  executedAt?: string;
}

export interface AuditorsAnswer {
  runId: string;
  /** who acted */
  agent: string;
  /** on whose behalf */
  principal: string;
  startedAt: string;
  status: string;
  actions: AuditedAction[];
}

export type AuditorsAnswerResult =
  | { ok: true; answer: AuditorsAnswer }
  | { ok: false; error: "not_found" | "unreplayable" };

export async function auditorsAnswer(
  store: EventStore,
  runId: string,
): Promise<AuditorsAnswerResult> {
  const loaded = await store.load(runId);
  if (loaded === null) return { ok: false, error: "not_found" };
  const replayed = replay(loaded.events);
  if (!replayed.ok) return { ok: false, error: "unreplayable" };
  const { state } = replayed;

  const actions: AuditedAction[] = [];
  let current: AuditedAction | null = null;
  for (const event of loaded.events) {
    switch (event.type) {
      case "ToolIntentEmitted":
        current = {
          tool: event.tool,
          risk: event.risk,
          args: event.args,
          intentAt: formatUtc(event.at),
          outcome: "pending",
        };
        actions.push(current);
        break;
      case "PolicyEvaluated":
        if (current) {
          current.decision = event.decision;
          current.rule = event.rule;
          if (event.decision === "deny") current.outcome = "refused";
        }
        break;
      case "ApprovalGranted":
        if (current) current.approvedBy = event.by;
        break;
      case "ApprovalDenied":
        if (current) {
          current.deniedBy = event.by;
          current.outcome = "refused";
        }
        break;
      case "ToolExecuted":
        if (current) {
          current.outcome = "executed";
          current.executedAt = formatUtc(event.at);
          current = null;
        }
        break;
      case "ToolFailed":
        if (current) {
          current.outcome = "failed";
          current = null;
        }
        break;
      default:
        break;
    }
  }

  return {
    ok: true,
    answer: {
      runId: state.runId,
      agent: state.agent,
      principal: state.principal,
      startedAt: formatUtc(state.startedAt),
      status: state.status,
      actions,
    },
  };
}

/** The one-command answer, printable: every line names its audit dimension. */
export function renderAuditorsAnswer(answer: AuditorsAnswer): string {
  const lines = [
    `run:             ${answer.runId} (${answer.status})`,
    `who acted:       ${answer.agent}`,
    `on whose behalf: ${answer.principal}`,
    `started:         ${answer.startedAt}`,
  ];
  answer.actions.forEach((action, index) => {
    lines.push(
      `action ${index + 1}:        ${action.tool} [${action.risk}] — ${action.outcome}`,
      `  when:          ${action.intentAt}${action.executedAt ? ` → executed ${action.executedAt}` : ""}`,
      `  under rule:    ${action.rule ?? "(no policy decision recorded)"} (${action.decision ?? "-"})`,
    );
    if (action.approvedBy) lines.push(`  approved by:   ${action.approvedBy}`);
    if (action.deniedBy) lines.push(`  denied by:     ${action.deniedBy}`);
  });
  return lines.join("\n");
}
