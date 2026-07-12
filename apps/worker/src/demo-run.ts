import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { loadAgentsConfig, resolveAgentAlias } from "./agents/registry.js";
import { startAgentRun, taskQueueFor } from "./client.js";

// Trigger the demo write run inside the artifact (ticket 021) — the smallest
// honest mechanism to exercise the governed write path: a CLI hook run via
// `docker compose exec worker`, not a console write UI (out of scope).
// Since ticket 028 the agent argument may be an ALIAS: with AGENTS_CONFIG
// mounted it resolves through the environment pointer, so promotions and
// rollbacks change what the demo runs without touching this script.
async function main(): Promise<void> {
  // --tenant <id> (ticket 037) targets that tenant's task queue lane
  const argv = process.argv.slice(2);
  let tenant: string | undefined;
  const tenantFlag = argv.indexOf("--tenant");
  if (tenantFlag !== -1) {
    tenant = argv[tenantFlag + 1];
    if (!tenant) {
      console.error("--tenant requires a tenant id");
      process.exit(2);
    }
    argv.splice(tenantFlag, 2);
  }
  const runId = argv[0];
  const agentArg = argv[1] ?? "demo-agent@v1";
  if (!runId) {
    console.error("usage: tsx src/demo-run.ts <runId> [agent-alias-or-version] [--tenant <id>]");
    process.exit(2);
  }

  let agent = agentArg;
  let model = "stub-model";
  let prompt = "append the drill note";
  const agentsConfigPath = process.env["AGENTS_CONFIG"];
  if (agentsConfigPath) {
    const loaded = loadAgentsConfig(JSON.parse(await readFile(agentsConfigPath, "utf8")));
    if (!loaded.ok) throw new Error(loaded.error);
    const resolved = resolveAgentAlias(
      loaded.config,
      agentArg,
      process.env["PLATFORM_ENV"] ?? "dev",
    );
    if (!resolved.ok) throw new Error(resolved.error);
    agent = resolved.id;
    model = resolved.spec.model;
    prompt = resolved.spec.prompt;
  }

  const connection = await Connection.connect({
    address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
  });
  try {
    const client = new Client({
      connection,
      namespace: process.env["TEMPORAL_NAMESPACE"] ?? "default",
    });
    const handle = await startAgentRun(
      client,
      {
        runId,
        agent,
        principal: "user:demo",
        input: { source: "write-drill" },
        model,
        prompt,
        approvalTtlMs: 10 * 60 * 1000,
      },
      tenant !== undefined ? { tenant } : undefined,
    );
    console.log(
      `started run ${handle.workflowId} as ${agent}` +
        (tenant !== undefined ? ` (tenant ${tenant}, queue ${taskQueueFor(tenant)})` : ""),
    );
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
