import { Client, Connection } from "@temporalio/client";

// The console signals workflows by name — the signal contract is
// "approvalDecision" (apps/worker/src/workflows.ts); the string is used
// directly so the worker package never enters the Next bundle.
export interface ApprovalDecisionPayload {
  granted: boolean;
  by: string;
  comment?: string;
}

let clientPromise: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  clientPromise ??= (async () => {
    const address = process.env["TEMPORAL_ADDRESS"];
    if (!address) {
      throw new Error("TEMPORAL_ADDRESS is not configured — cannot signal the run engine");
    }
    const connection = await Connection.connect({ address });
    return new Client({
      connection,
      namespace: process.env["TEMPORAL_NAMESPACE"] ?? "default",
    });
  })();
  return clientPromise;
}

/** Approve/deny the run's pending intent (workflowId = runId, ticket 003/017). */
export async function signalApprovalDecision(
  runId: string,
  decision: ApprovalDecisionPayload,
): Promise<void> {
  const client = await getClient();
  await client.workflow.getHandle(runId).signal("approvalDecision", decision);
}

/** Hand the pending approval to a named person (ticket 050) — by signal,
 * because the workflow is the single writer of an active run's log. */
export async function signalApprovalDelegation(
  workflowId: string,
  delegation: { toPrincipal: string; by: string },
): Promise<void> {
  const client = await getClient();
  await client.workflow.getHandle(workflowId).signal("approvalDelegation", delegation);
}

/**
 * Start an agentRun by workflow-type name (ticket 023) — the string keeps
 * the worker package out of the Next bundle, same reasoning as the signal
 * above. A duplicate workflowId is reported, not thrown: that is webhook
 * redelivery working as designed (003 idempotency).
 */
export async function startAgentRunByName(
  workflowId: string,
  input: Record<string, unknown>,
  options?: { taskQueue?: string },
): Promise<"started" | "duplicate"> {
  const client = await getClient();
  try {
    await client.workflow.start("agentRun", {
      workflowId,
      // ticket 054: tenanted launches name their lane's queue explicitly
      taskQueue: options?.taskQueue ?? process.env["TEMPORAL_TASK_QUEUE"] ?? "agent-runs",
      args: [input],
    });
    return "started";
  } catch (error) {
    if ((error as { name?: string }).name === "WorkflowExecutionAlreadyStartedError") {
      return "duplicate";
    }
    throw error;
  }
}
