import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { startAgentRun } from "./client.js";

// Trigger the demo write run inside the artifact (ticket 021) — the smallest
// honest mechanism to exercise the governed write path: a CLI hook run via
// `docker compose exec worker`, not a console write UI (out of scope).
async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: tsx src/demo-run.ts <runId>");
    process.exit(2);
  }
  const connection = await Connection.connect({
    address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
  });
  try {
    const client = new Client({
      connection,
      namespace: process.env["TEMPORAL_NAMESPACE"] ?? "default",
    });
    const handle = await startAgentRun(client, {
      runId,
      agent: "demo-agent@v1",
      principal: "user:demo",
      input: { source: "write-drill" },
      model: "stub-model",
      prompt: "append the drill note",
      approvalTtlMs: 10 * 60 * 1000,
    });
    console.log(`started run ${handle.workflowId}`);
  } finally {
    await connection.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
