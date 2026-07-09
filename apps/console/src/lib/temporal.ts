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
