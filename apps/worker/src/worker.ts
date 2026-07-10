import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createPostgresEventStore, InMemoryEventStore } from "@platform/storage";
import type { EventStore } from "@platform/storage";
import { createGateway, FakeProvider, fakeIntent, fakeMessage } from "@platform/model-gateway";
import type { FakeBehavior } from "@platform/model-gateway";
import { DEFAULT_RULES } from "@platform/policy";
import { ToolRegistry } from "@platform/tool-registry";
import { createToolGateway } from "@platform/tool-gateway";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./client.js";
import { buildTools } from "./tools-config.js";
import type { BuiltTools } from "./tools-config.js";

export const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));

/**
 * Worker bootstrap. Store from env (ticket 011): DATABASE_URL → Postgres
 * adapter with migrations applied on boot (the worker owns migrations), else
 * in-memory. Tools come from TOOLS_CONFIG (ticket 021): a zod-validated JSON
 * file selecting from the built-in catalog — registry, grants, and egress are
 * configuration, never code. Model provider is still the stub until a real
 * key is configured (ticket 007's provider slots in via ANTHROPIC_API_KEY in
 * a later wiring).
 */
export async function runWorker(): Promise<void> {
  const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
  const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
  const databaseUrl = process.env["DATABASE_URL"];
  const platformEnv = process.env["PLATFORM_ENV"] ?? "dev";

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
    env: platformEnv,
    allowlist: ["stub-model"],
    pricing: { "stub-model": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
    providers: [{ name: "stub", provider: new FakeProvider(stubScript()) }],
  });

  const tools = createToolGateway({
    ...(await loadTools()),
    rules: DEFAULT_RULES,
    env: platformEnv,
  });

  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: createActivities({ store, gateway, tools }),
    });
    await worker.run();
  } finally {
    await connection.close();
    await closeStore();
  }
}

/**
 * TOOLS_CONFIG (path to zod-validated JSON) decides which catalog tools are
 * enabled, who is granted them, and the egress allowlist. Without it the
 * worker runs with NO tools: every intent is refused-and-audited. An invalid
 * config is a boot failure — never a silently-empty gateway.
 */
async function loadTools(): Promise<BuiltTools> {
  const configPath = process.env["TOOLS_CONFIG"];
  if (!configPath) {
    console.log("worker: no TOOLS_CONFIG — zero tools enabled, all intents will be refused");
    return {
      registry: new ToolRegistry(),
      grants: [],
      executors: [],
      egressAllowlist: [],
      mcpClients: [],
    };
  }
  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const built = await buildTools(raw, {
    ...(process.env["NOTES_FILE"] ? { notesFile: process.env["NOTES_FILE"] } : {}),
  });
  if (!built.ok) throw new Error(`worker: TOOLS_CONFIG rejected — ${built.error}`);
  const enabled = built.tools.registry.describeAll().map((t) => `${t.name}@${t.version}`);
  console.log(`worker: tools enabled from config: ${enabled.join(", ") || "(none)"}`);
  return built.tools;
}

/**
 * Stub model scripts (until ticket 007's real provider is wired): the
 * artifact's demo runs are scripted, deterministic model behavior.
 * STUB_SCRIPT=demo-write emits the reference write intent then completes —
 * the write drill's model behavior (ticket 021).
 */
function stubScript(): FakeBehavior[] {
  if (process.env["STUB_SCRIPT"] === "demo-write") {
    return [
      {
        kind: "respond",
        result: fakeIntent(
          { tool: "notes.append@v1", args: { text: "reference write drill note" } },
          undefined,
          "stub-model",
        ),
      },
      { kind: "respond", result: fakeMessage("drill note appended", undefined, "stub-model") },
    ];
  }
  return [
    {
      kind: "respond",
      result: fakeMessage("no real provider configured yet (ticket 007)", undefined, "stub-model"),
    },
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
