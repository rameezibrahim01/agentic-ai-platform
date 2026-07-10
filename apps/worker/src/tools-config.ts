import { z } from "zod";
import { riskTierSchema } from "@platform/core";
import { refKey, ToolRegistry } from "@platform/tool-registry";
import type { AgentGrants } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";
import { notesAppendContract, notesAppendExecutor } from "./tools/notes.js";
import { McpStdioClient } from "./mcp/client.js";
import { wrapMcpTool } from "./mcp/wrap.js";

// Config-driven tool wiring (tickets 021 + 024, architecture §6): the worker
// ships with a CATALOG of built-in tool implementations and an MCP transport,
// but registers, grants, and allows egress for NOTHING unless the mounted
// config file says so. Which tools exist — native or wrapped from an
// external MCP server — who may call them, and where they may reach is
// configuration, never code. Nothing an MCP server advertises carries
// authority: config names each wrapped tool and assigns its risk tier.

const toolRefSchema = z
  .object({ name: z.string().min(1), version: z.string().min(1) })
  .strict();

const mcpToolConfigSchema = z
  .object({
    /** Must match a tool the server advertises. */
    name: z.string().min(1),
    version: z.string().min(1),
    /** Assigned HERE, never taken from the server. */
    risk: riskTierSchema,
    description: z.string().min(1).optional(),
    egress: z.array(z.string()).default([]),
  })
  .strict();

const mcpServerConfigSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Only these are wrapped; everything else the server offers does not exist. */
    tools: z.array(mcpToolConfigSchema).min(1),
  })
  .strict();

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const toolsConfigSchema = z
  .object({
    /** Catalog refs ("name@version") this deployment enables. */
    tools: z.array(z.string().min(1)),
    grants: z
      .array(
        z.object({ agent: z.string().min(1), tools: z.array(toolRefSchema).min(1) }).strict(),
      )
      .default([]),
    egressAllowlist: z.array(z.string()).default([]),
    mcpServers: z.array(mcpServerConfigSchema).default([]),
  })
  .strict();

export type ToolsConfig = z.infer<typeof toolsConfigSchema>;

export interface CatalogDeps {
  /** Absolute path of the mounted notes file (required by notes.append@v1). */
  notesFile?: string;
}

interface CatalogEntry {
  contract: typeof notesAppendContract;
  makeExecutor(deps: CatalogDeps): { ok: true; executor: ToolExecutor } | { ok: false; error: string };
}

const CATALOG: Record<string, CatalogEntry> = {
  [refKey(notesAppendContract)]: {
    contract: notesAppendContract,
    makeExecutor: (deps) =>
      deps.notesFile
        ? { ok: true, executor: notesAppendExecutor(deps.notesFile) }
        : { ok: false, error: "notes.append@v1 requires NOTES_FILE" },
  },
};

export interface BuiltTools {
  registry: ToolRegistry;
  grants: AgentGrants[];
  executors: ToolExecutor[];
  egressAllowlist: string[];
  /** Live MCP server connections backing wrapped executors; close in tests. */
  mcpClients: McpStdioClient[];
}

export type BuildToolsResult =
  | { ok: true; tools: BuiltTools }
  | { ok: false; error: string };

export type McpConnector = (server: McpServerConfig) => Promise<McpStdioClient>;

const defaultConnector: McpConnector = (server) =>
  McpStdioClient.connect(server.command, server.args);

/** Parse + validate a tools config document and assemble the gateway inputs. */
export async function buildTools(
  rawConfig: unknown,
  deps: CatalogDeps,
  connectMcp: McpConnector = defaultConnector,
): Promise<BuildToolsResult> {
  const parsed = toolsConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid tools config: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const config = parsed.data;

  const registry = new ToolRegistry();
  const executors: ToolExecutor[] = [];
  const mcpClients: McpStdioClient[] = [];
  const enabled = new Set<string>();
  const failBoot = (error: string): BuildToolsResult => {
    mcpClients.forEach((client) => client.close());
    return { ok: false, error };
  };

  for (const ref of config.tools) {
    const entry = CATALOG[ref];
    if (entry === undefined) {
      return failBoot(`unknown tool ${ref} — not in this worker's catalog`);
    }
    const made = entry.makeExecutor(deps);
    if (!made.ok) return failBoot(made.error);
    registry.register(entry.contract);
    executors.push(made.executor);
    enabled.add(ref);
  }

  // wrapped MCP tools: connect, then register ONLY what config lists —
  // a connection or schema-conversion failure is a boot failure
  for (const server of config.mcpServers) {
    let client: McpStdioClient;
    try {
      client = await connectMcp(server);
      mcpClients.push(client);
      const advertised = new Map((await client.listTools()).map((t) => [t.name, t]));
      for (const toolConfig of server.tools) {
        const serverTool = advertised.get(toolConfig.name);
        if (serverTool === undefined) {
          return failBoot(`mcp server ${server.name} does not advertise ${toolConfig.name}`);
        }
        const wrapped = wrapMcpTool(client, serverTool, toolConfig);
        if (!wrapped.ok) return failBoot(wrapped.error);
        const ref = refKey(wrapped.contract);
        const registered = registry.register(wrapped.contract);
        if (!registered.ok) {
          return failBoot(`mcp tool ${ref} collides with an already-registered tool`);
        }
        executors.push(wrapped.executor);
        enabled.add(ref);
      }
    } catch (error) {
      return failBoot(
        `mcp server ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // grants may only reference enabled tools — a grant to a ghost tool is a
  // config mistake, surfaced at boot rather than as runtime refusals
  for (const grant of config.grants) {
    for (const tool of grant.tools) {
      if (!enabled.has(refKey(tool))) {
        return failBoot(
          `grant for ${grant.agent} references ${refKey(tool)}, which is not enabled`,
        );
      }
    }
  }

  return {
    ok: true,
    tools: {
      registry,
      grants: config.grants,
      executors,
      egressAllowlist: config.egressAllowlist,
      mcpClients,
    },
  };
}
