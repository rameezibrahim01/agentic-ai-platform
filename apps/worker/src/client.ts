import type { Client, WorkflowHandle } from "@temporalio/client";
import type { AgentRunInput, AgentRunResult, ApprovalDecision, ApprovalDelegation } from "./workflows.js";
import { agentRun, approvalDecisionSignal, approvalDelegationSignal } from "./workflows.js";

export const TASK_QUEUE = "agent-runs";

/** Tenant lane naming (ticket 037). Untenanted stays byte-identical. */
export function taskQueueFor(tenantId?: string): string {
  return tenantId === undefined ? TASK_QUEUE : `${TASK_QUEUE}--${tenantId}`;
}

/**
 * WorkflowIds are namespace-global in Temporal, so tenanted runs qualify the
 * id — the same runId in two tenants is two independent workflows, and
 * duplicate starts still dedupe WITHIN a tenant. Untenanted ids unchanged.
 */
export function workflowIdFor(runId: string, tenantId?: string): string {
  return tenantId === undefined ? runId : `${tenantId}--${runId}`;
}

/** Start a durable agent run; the workflowId derives from the runId, so duplicate starts dedupe. */
export async function startAgentRun(
  client: Client,
  input: AgentRunInput & { runId: string },
  options?: { taskQueue?: string; tenant?: string },
): Promise<WorkflowHandle<typeof agentRun>> {
  return client.workflow.start(agentRun, {
    taskQueue: options?.taskQueue ?? taskQueueFor(options?.tenant),
    workflowId: workflowIdFor(input.runId, options?.tenant),
    args: [input],
  });
}

/** Approve or deny a run's pending intent (ticket 017). workflowId derives from runId. */
export async function sendApprovalDecision(
  client: Client,
  runId: string,
  decision: ApprovalDecision,
  options?: { tenant?: string },
): Promise<void> {
  await client.workflow
    .getHandle(workflowIdFor(runId, options?.tenant))
    .signal(approvalDecisionSignal, decision);
}

/** Hand the pending approval to a named person (ticket 050). */
export async function sendApprovalDelegation(
  client: Client,
  runId: string,
  delegation: ApprovalDelegation,
  options?: { tenant?: string },
): Promise<void> {
  await client.workflow
    .getHandle(workflowIdFor(runId, options?.tenant))
    .signal(approvalDelegationSignal, delegation);
}

export type { AgentRunInput, AgentRunResult, ApprovalDecision, ApprovalDelegation };
