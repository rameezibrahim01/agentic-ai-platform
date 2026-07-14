import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  createPostgresEventStore,
  InMemoryEventStore,
  makeEncryptedEventCodec,
} from "@platform/storage";
import type { EventStore } from "@platform/storage";
import { fakeIntent, fakeMessage } from "@platform/model-gateway";
import type { FakeBehavior } from "@platform/model-gateway";
import { buildModelGateway } from "./model-config.js";
import { makeLimitsLoader, makeTenantLimitsLoader } from "./limits.js";
import { makeNotifier, NO_NOTIFIER } from "./notify.js";
import type { Notifier } from "./notify.js";
import { DEFAULT_RULES } from "@platform/policy";
import { ToolRegistry } from "@platform/tool-registry";
import { createToolGateway } from "@platform/tool-gateway";
import { createActivities } from "./activities.js";
import { TASK_QUEUE, taskQueueFor } from "./client.js";
import { describeLaneConfig, resolveLaneConfig } from "./tenant-configs.js";
import { openTenantStores, parseTenantsConfig } from "./tenants.js";
import { buildTools } from "./tools-config.js";
import type { BuiltTools } from "./tools-config.js";
import type { ToolGateway } from "@platform/tool-gateway";
import type { ModelGateway } from "@platform/model-gateway";

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

  // Real provider when a key is configured (ticket 026): key from env only,
  // models from MODELS_CONFIG only, stub always present as the failover.
  const modelsConfigPath = process.env["MODELS_CONFIG"];
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const built = buildModelGateway({
    env: platformEnv,
    stubScript: stubScript(),
    ...(apiKey ? { apiKey } : {}),
    ...(modelsConfigPath
      ? { modelsConfig: JSON.parse(await readFile(modelsConfigPath, "utf8")) as unknown }
      : {}),
  });
  if (!built.ok) throw new Error(`worker: MODELS_CONFIG rejected — ${built.error}`);
  console.log(`worker: ${built.summary}`);
  const gateway = built.gateway;

  const tools = createToolGateway({
    ...(await loadTools()),
    rules: DEFAULT_RULES,
    env: platformEnv,
  });

  // Approval notifications (ticket 051): validated at boot, shared by every
  // lane in this slice; no config = no notifications, byte-identical.
  let notify: Notifier = NO_NOTIFIER;
  const notificationsPath = process.env["NOTIFICATIONS_CONFIG"];
  if (notificationsPath) {
    const made = makeNotifier(JSON.parse(await readFile(notificationsPath, "utf8")));
    if (!made.ok) throw new Error(`worker: ${made.error}`);
    notify = made.notifier;
    console.log(`worker: ${made.summary}`);
  }

  // Tenanted deployment (ticket 037): TENANTS_CONFIG turns the process into
  // one lane per tenant — own queue, own store, own key, own limits. There is
  // no untenanted lane in tenanted mode: every run belongs to a tenant.
  const tenantsConfigPath = process.env["TENANTS_CONFIG"];
  if (tenantsConfigPath) {
    if (!databaseUrl) {
      throw new Error(
        "worker: TENANTS_CONFIG requires DATABASE_URL — tenant isolation is schema-per-tenant Postgres",
      );
    }
    await runTenantWorkers({
      address,
      namespace,
      databaseUrl,
      tenantsConfigPath,
      platformEnv,
      gateway,
      tools,
      notify,
    });
    return;
  }

  // BYOK-style payload encryption (ticket 035): the client's key makes the
  // logs readable; without it stored rows stay dark. Key from env only.
  const dataKey = process.env["PLATFORM_DATA_KEY"];
  const codec = dataKey ? makeEncryptedEventCodec(dataKey) : undefined;

  let store: EventStore;
  let closeStore: () => Promise<void> = async () => {};
  if (databaseUrl) {
    const handle = await createPostgresEventStore(databaseUrl, codec); // runs migrations
    store = handle.store;
    closeStore = handle.close;
    console.log(
      `worker: using Postgres event store (migrations applied)${codec ? "; payload encryption ON" : ""}`,
    );
  } else {
    store = new InMemoryEventStore();
    console.log("worker: using in-memory event store (set DATABASE_URL for durability)");
  }

  // operator limits (ticket 033): validate at boot (fail fast on a bad file),
  // then re-read per check so switch flips take effect without a restart
  const limitsPath = process.env["LIMITS_CONFIG"];
  const loadLimits = makeLimitsLoader(limitsPath);
  const boot = await loadLimits();
  console.log(
    `worker: limits ${limitsPath ? `from ${limitsPath}` : "not configured"}; global kill switch: ${boot.killSwitches.global}`,
  );

  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: createActivities({ store, gateway, tools, limits: { load: loadLimits }, notify }),
    });
    await worker.run();
  } finally {
    await connection.close();
    await closeStore();
  }
}

/**
 * One worker process, one isolated lane per tenant (ticket 037): each lane's
 * activities are constructed with exactly one tenant's store, codec, and
 * limits in hand — a run on tenant A's queue physically cannot write tenant
 * B's schema. Model/tool gateways are shared platform capability in this
 * slice. Limits: `limits.<tenantId>.config.json` beside the shared
 * LIMITS_CONFIG wins when present, else the shared file governs the lane.
 */
async function runTenantWorkers(options: {
  address: string;
  namespace: string;
  databaseUrl: string;
  tenantsConfigPath: string;
  platformEnv: string;
  gateway: ModelGateway;
  tools: ToolGateway;
  notify: Notifier;
}): Promise<void> {
  const parsed = parseTenantsConfig(
    JSON.parse(await readFile(options.tenantsConfigPath, "utf8")) as unknown,
  );
  if (!parsed.ok) throw new Error(`worker: TENANTS_CONFIG rejected — ${parsed.error}`);

  const sharedLimitsPath = process.env["LIMITS_CONFIG"];
  const pool = new pg.Pool({ connectionString: options.databaseUrl });
  try {
    const tenants = await openTenantStores(pool, parsed.config); // migrates every schema
    const connection = await NativeConnection.connect({ address: options.address });
    try {
      const workers: Worker[] = [];
      for (const [tenantId, tenant] of tenants) {
        const tenantLimitsPath = sharedLimitsPath
          ? join(dirname(sharedLimitsPath), `limits.${tenantId}.config.json`)
          : undefined;
        const load = tenantLimitsPath
          ? makeTenantLimitsLoader(tenantLimitsPath, sharedLimitsPath)
          : makeLimitsLoader(undefined);
        const boot = await load(); // fail fast on a bad limits file

        // Per-lane tool/model configs (ticket 041): `<kind>.<id>.config.json`
        // beside the shared file governs this lane; absent reuses the shared
        // gateway; INVALID is a boot failure for the whole process.
        const toolsSource = await resolveLaneConfig(
          process.env["TOOLS_CONFIG"],
          "tools",
          tenantId,
        );
        let laneTools = options.tools;
        if (toolsSource.source === "tenant") {
          laneTools = createToolGateway({
            ...(await loadToolsFrom(toolsSource.path, `tenant ${tenantId}`)),
            rules: DEFAULT_RULES,
            env: options.platformEnv,
          });
        }
        const modelsSource = await resolveLaneConfig(
          process.env["MODELS_CONFIG"],
          "models",
          tenantId,
        );
        let laneGateway = options.gateway;
        if (modelsSource.source === "tenant") {
          const apiKey = process.env["ANTHROPIC_API_KEY"];
          const built = buildModelGateway({
            env: options.platformEnv,
            stubScript: stubScript(),
            ...(apiKey ? { apiKey } : {}),
            modelsConfig: JSON.parse(await readFile(modelsSource.path, "utf8")) as unknown,
          });
          if (!built.ok) {
            throw new Error(`worker: tenant ${tenantId} models config rejected — ${built.error}`);
          }
          laneGateway = built.gateway;
        }

        console.log(
          `worker: tenant ${tenantId} → queue ${taskQueueFor(tenantId)}, schema ${tenant.schema}, ` +
            `encryption ${tenant.spec.dataKeyEnv ? "ON" : "off"}, global kill switch: ${boot.killSwitches.global}, ` +
            `tools: ${describeLaneConfig(toolsSource)}, models: ${describeLaneConfig(modelsSource)}`,
        );
        workers.push(
          await Worker.create({
            connection,
            namespace: options.namespace,
            taskQueue: taskQueueFor(tenantId),
            workflowsPath,
            activities: createActivities({
              store: tenant.store,
              gateway: laneGateway,
              tools: laneTools,
              limits: { load },
              notify: options.notify,
            }),
          }),
        );
      }
      // joint lifecycle: one lane failing takes the whole process down
      // cleanly instead of leaving it half-alive
      await Promise.all(
        workers.map((worker) =>
          worker.run().catch((error: unknown) => {
            for (const other of workers) {
              try {
                other.shutdown();
              } catch {
                // already stopping
              }
            }
            throw error;
          }),
        ),
      );
    } finally {
      await connection.close();
    }
  } finally {
    await pool.end();
  }
}

/**
 * TOOLS_CONFIG (path to zod-validated JSON) decides which catalog tools are
 * enabled, who is granted them, and the egress allowlist. Without it the
 * worker runs with NO tools: every intent is refused-and-audited. An invalid
 * config is a boot failure — never a silently-empty gateway.
 */
async function loadTools(): Promise<BuiltTools> {
  return loadToolsFrom(process.env["TOOLS_CONFIG"], "shared");
}

async function loadToolsFrom(configPath: string | undefined, label: string): Promise<BuiltTools> {
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
  // the shared path keeps its exact pre-041 wording — drills grep these lines
  const scope = label === "shared" ? "TOOLS_CONFIG" : `tools config (${label})`;
  if (!built.ok) throw new Error(`worker: ${scope} rejected — ${built.error}`);
  const enabled = built.tools.registry.describeAll().map((t) => `${t.name}@${t.version}`);
  const suffix = label === "shared" ? "from config" : `(${label})`;
  console.log(`worker: tools enabled ${suffix}: ${enabled.join(", ") || "(none)"}`);
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
  // ticket 060: the department demo's scripted model — read a spreadsheet
  // (auto-executes: read tier), then append a findings row (pauses in prod)
  if (process.env["STUB_SCRIPT"] === "demo-sheet") {
    return [
      {
        kind: "respond",
        result: fakeIntent(
          { tool: "sheet.read@v1", args: { path: "invoices-2026-q2.csv" } },
          undefined,
          "stub-model",
        ),
      },
      {
        kind: "respond",
        result: fakeIntent(
          {
            tool: "sheet.append@v1",
            args: {
              path: "findings.csv",
              row: [
                "INV-1008",
                "Falcon Office Supplies",
                "pending > 30 days, amount matches quarterly pattern",
                'memo check: "no rate change" for this vendor',
              ],
            },
          },
          undefined,
          "stub-model",
        ),
      },
      {
        kind: "respond",
        result: fakeMessage("findings row appended for review", undefined, "stub-model"),
      },
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
