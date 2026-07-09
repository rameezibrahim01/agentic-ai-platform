import type { Client, WorkflowHandle } from "@temporalio/client";
import type { AgentRunInput, AgentRunResult, ApprovalDecision } from "./workflows.js";
import { agentRun, approvalDecisionSignal } from "./workflows.js";

export const TASK_QUEUE = "agent-runs";

/** Start a durable agent run; the workflowId is the runId, so duplicate starts dedupe. */
export async function startAgentRun(
  client: Client,
  input: AgentRunInput & { runId: string },
  options?: { taskQueue?: string },
): Promise<WorkflowHandle<typeof agentRun>> {
  return client.workflow.start(agentRun, {
    taskQueue: options?.taskQueue ?? TASK_QUEUE,
    workflowId: input.runId,
    args: [input],
  });
}

/** Approve or deny a run's pending intent (ticket 017). workflowId = runId. */
export async function sendApprovalDecision(
  client: Client,
  runId: string,
  decision: ApprovalDecision,
): Promise<void> {
  await client.workflow.getHandle(runId).signal(approvalDecisionSignal, decision);
}

export type { AgentRunInput, AgentRunResult, ApprovalDecision };
