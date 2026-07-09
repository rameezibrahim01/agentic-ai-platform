import type { Client, WorkflowHandle } from "@temporalio/client";
import type { AgentRunInput, AgentRunResult } from "./workflows.js";
import { agentRun } from "./workflows.js";

export const TASK_QUEUE = "agent-runs";

/** Start a durable agent run; the workflowId is the runId, so duplicate starts dedupe. */
export async function startAgentRun(
  client: Client,
  input: AgentRunInput,
  options?: { taskQueue?: string },
): Promise<WorkflowHandle<typeof agentRun>> {
  return client.workflow.start(agentRun, {
    taskQueue: options?.taskQueue ?? TASK_QUEUE,
    workflowId: input.runId,
    args: [input],
  });
}

export type { AgentRunInput, AgentRunResult };
