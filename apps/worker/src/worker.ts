import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { InMemoryEventStore } from "@platform/storage";
import { createGateway, FakeProvider, fakeMessage } from "@platform/model-gateway";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./client.js";

export const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));

/**
 * Worker bootstrap. Placeholder wiring until later tickets: in-memory store
 * (Postgres = 006), FakeProvider behind the gateway (Anthropic = 007). Runs
 * survive worker crashes via Temporal history either way.
 */
export async function runWorker(): Promise<void> {
  const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
  const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
  const gateway = createGateway({
    env: process.env["PLATFORM_ENV"] ?? "dev",
    allowlist: ["stub-model"],
    pricing: { "stub-model": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
    providers: [
      {
        name: "stub",
        provider: new FakeProvider([
          {
            kind: "respond",
            result: fakeMessage("no real provider configured yet (ticket 007)", undefined, "stub-model"),
          },
        ]),
      },
    ],
  });
  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: createActivities({ store: new InMemoryEventStore(), gateway }),
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
