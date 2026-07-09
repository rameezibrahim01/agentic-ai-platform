import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { InMemoryEventStore } from "@platform/storage";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./client.js";

export const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));

/**
 * Worker bootstrap. Uses the in-memory store until the Postgres adapter
 * (ticket 006) — runs survive worker crashes via Temporal history either way;
 * the store is the queryable projection.
 */
export async function runWorker(): Promise<void> {
  const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
  const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: createActivities(new InMemoryEventStore()),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
