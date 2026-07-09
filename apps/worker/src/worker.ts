import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createPostgresEventStore, InMemoryEventStore } from "@platform/storage";
import type { EventStore } from "@platform/storage";
import { createGateway, FakeProvider, fakeMessage } from "@platform/model-gateway";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./client.js";

export const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));

/**
 * Worker bootstrap. Store from env (ticket 011): DATABASE_URL → Postgres
 * adapter with migrations applied on boot (the worker owns migrations), else
 * in-memory. Model provider is still the stub until a real key is configured
 * (ticket 007's provider slots in via ANTHROPIC_API_KEY in a later wiring).
 */
export async function runWorker(): Promise<void> {
  const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
  const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
  const databaseUrl = process.env["DATABASE_URL"];

  let store: EventStore;
  let closeStore: () => Promise<void> = async () => {};
  if (databaseUrl) {
    const handle = await createPostgresEventStore(databaseUrl); // runs migrations
    store = handle.store;
    closeStore = handle.close;
    console.log("worker: using Postgres event store (migrations applied)");
  } else {
    store = new InMemoryEventStore();
    console.log("worker: using in-memory event store (set DATABASE_URL for durability)");
  }

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
      activities: createActivities({ store, gateway }),
    });
    await worker.run();
  } finally {
    await connection.close();
    await closeStore();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
