import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { riskTierSchema } from "@platform/core";
import { refKey, ToolRegistry } from "@platform/tool-registry";
import type { AgentGrants } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";
import {
  docsListContract,
  docsListExecutor,
  docsReadContract,
  docsReadExecutor,
  sheetAppendContract,
  sheetAppendExecutor,
  sheetReadContract,
  sheetReadExecutor,
} from "./tools/files.js";
import {
  hostOf,
  mailReadContract,
  mailReadExecutor,
  mailSearchContract,
  mailSearchExecutor,
  mailSendContract,
  mailSendExecutor,
  makeImapMailbox,
  makeSmtpSender,
} from "./tools/mail.js";
import type { MailboxClient, MailSender } from "./tools/mail.js";
import { notesAppendContract, notesAppendExecutor } from "./tools/notes.js";
import { sqlQueryContract, sqlQueryExecutor } from "./tools/sql.js";
import { McpStdioClient } from "./mcp/client.js";
import { wrapMcpTool } from "./mcp/wrap.js";
import { generateOpenApiTool } from "./openapi/generate.js";
import type { OpenApiAuthScheme } from "./openapi/generate.js";

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

const openapiToolsConfigSchema = z
  .object({
    /** Path to a LOCAL OpenAPI 3.0 JSON document (no spec fetching). */
    spec: z.string().min(1),
    /** How the API_TOKEN secret becomes a header, when the API needs auth. */
    auth: z
      .union([z.literal("bearer"), z.string().regex(/^header:[A-Za-z0-9-]+$/)])
      .optional(),
    /** Only these operations become tools; risk assigned here, never inferred. */
    operations: z
      .array(
        z
          .object({
            operationId: z.string().min(1),
            version: z.string().min(1),
            risk: riskTierSchema,
            egress: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

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
    openapiTools: z.array(openapiToolsConfigSchema).default([]),
    /** Ticket 045: required when tools includes sql.query@v1. The env var
     * NAME holding the read-only connection string — never the string. */
    sqlTools: z.object({ connectionEnv: z.string().min(1) }).strict().optional(),
    /** Ticket 057: required when tools include the file connector. docsDir
     * is the read-only root; dataDir the SEPARATE writable root that
     * sheet.append@v1 (and nothing else) may touch. */
    fileTools: z
      .object({ docsDir: z.string().min(1), dataDir: z.string().min(1).optional() })
      .strict()
      .optional(),
    /** Ticket 058: required when tools include the mail connector. Env var
     * NAMES only (046 rule) — the URLs embed credentials and never appear
     * here. No smtpUrlEnv = read-only mailbox; no allowedRecipientDomains =
     * every send refused (deny by default). */
    mailTools: z
      .object({
        imapUrlEnv: z.string().min(1),
        smtpUrlEnv: z.string().min(1).optional(),
        allowedRecipientDomains: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ToolsConfig = z.infer<typeof toolsConfigSchema>;

export interface CatalogDeps {
  /** Absolute path of the mounted notes file (required by notes.append@v1). */
  notesFile?: string;
  /** Injectable transport for generated OpenAPI tools (tests never hit the network). */
  fetchFn?: typeof fetch;
  /** Injectable env for tests (sql.query@v1's connectionEnv). Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Ticket 058: hermetic seam — tests inject fakes; production builds real
   * IMAP/SMTP clients from the env URLs. */
  mailClients?: { mailbox?: MailboxClient; sender?: MailSender };
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

/** The read half of the file connector (057); sheet.append is handled
 * separately because it alone needs the writable dataDir. */
const FILE_TOOL_CONTRACTS: Record<
  string,
  {
    contract: typeof docsListContract;
    makeExecutor(roots: { docsDir: string; dataDir?: string }): ToolExecutor;
  }
> = {
  [refKey(docsListContract)]: { contract: docsListContract, makeExecutor: docsListExecutor },
  [refKey(docsReadContract)]: { contract: docsReadContract, makeExecutor: docsReadExecutor },
  [refKey(sheetReadContract)]: { contract: sheetReadContract, makeExecutor: sheetReadExecutor },
  [refKey(sheetAppendContract)]: {
    contract: sheetAppendContract,
    // never called (the loop special-cases append to enforce dataDir); the
    // entry exists so ref lookup treats all four as file-connector refs
    makeExecutor: () => {
      throw new Error("sheet.append is wired via its dataDir branch");
    },
  },
};

async function missingDirectory(dir: string): Promise<string | null> {
  try {
    const stats = await stat(dir);
    return stats.isDirectory() ? null : `${dir} exists but is not a directory`;
  } catch {
    return `${dir} does not exist`;
  }
}

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
    // file connector (ticket 057): needs its config section; a named
    // directory that is missing at boot is a loud boot failure, and
    // sheet.append additionally needs the SEPARATE writable dataDir
    const fileContract = FILE_TOOL_CONTRACTS[ref];
    if (fileContract !== undefined) {
      if (config.fileTools === undefined) {
        return failBoot(`${ref} requires the fileTools config`);
      }
      const docsDirError = await missingDirectory(config.fileTools.docsDir);
      if (docsDirError !== null) {
        return failBoot(`${ref}: fileTools.docsDir ${docsDirError}`);
      }
      if (ref === refKey(sheetAppendContract)) {
        if (config.fileTools.dataDir === undefined) {
          return failBoot("sheet.append@v1 requires fileTools.dataDir (the writable root)");
        }
        const dataDirError = await missingDirectory(config.fileTools.dataDir);
        if (dataDirError !== null) {
          return failBoot(`sheet.append@v1: fileTools.dataDir ${dataDirError}`);
        }
        registry.register(sheetAppendContract);
        executors.push(
          sheetAppendExecutor({ docsDir: config.fileTools.docsDir, dataDir: config.fileTools.dataDir }),
        );
      } else {
        registry.register(fileContract.contract);
        executors.push(fileContract.makeExecutor(config.fileTools));
      }
      enabled.add(ref);
      continue;
    }
    // mail connector (ticket 058): env var NAMES in config, URLs stay
    // secrets; reads need IMAP, mail.send additionally needs SMTP
    if (ref === "mail.search@v1" || ref === "mail.read@v1" || ref === "mail.send@v1") {
      if (config.mailTools === undefined) {
        return failBoot(`${ref} requires the mailTools config`);
      }
      const env = deps.env ?? process.env;
      const imapUrl = env[config.mailTools.imapUrlEnv];
      if (!imapUrl && deps.mailClients?.mailbox === undefined) {
        return failBoot(`${ref}: IMAP env ${config.mailTools.imapUrlEnv} is named but empty`);
      }
      if (ref === "mail.send@v1") {
        if (config.mailTools.smtpUrlEnv === undefined) {
          return failBoot("mail.send@v1 requires mailTools.smtpUrlEnv (read-only mailbox otherwise)");
        }
        const smtpUrl = env[config.mailTools.smtpUrlEnv];
        if (!smtpUrl && deps.mailClients?.sender === undefined) {
          return failBoot(`mail.send@v1: SMTP env ${config.mailTools.smtpUrlEnv} is named but empty`);
        }
        const egress = smtpUrl ? [hostOf(smtpUrl)] : [];
        registry.register(mailSendContract(egress));
        executors.push(
          mailSendExecutor(
            deps.mailClients?.sender ?? makeSmtpSender(smtpUrl!),
            config.mailTools.allowedRecipientDomains,
          ),
        );
      } else {
        const egress = imapUrl ? [hostOf(imapUrl)] : [];
        const mailbox = deps.mailClients?.mailbox ?? makeImapMailbox(imapUrl!);
        if (ref === "mail.search@v1") {
          registry.register(mailSearchContract(egress));
          executors.push(mailSearchExecutor(mailbox));
        } else {
          registry.register(mailReadContract(egress));
          executors.push(mailReadExecutor(mailbox));
        }
      }
      enabled.add(ref);
      continue;
    }
    // sql.query@v1 (ticket 045): needs its config section, not just deps —
    // the connection comes from the env var the config NAMES
    if (ref === refKey(sqlQueryContract)) {
      if (config.sqlTools === undefined) {
        return failBoot("sql.query@v1 requires the sqlTools.connectionEnv config");
      }
      const env = deps.env ?? process.env;
      const connection = env[config.sqlTools.connectionEnv];
      if (!connection) {
        return failBoot(
          `sql.query@v1: connection env ${config.sqlTools.connectionEnv} is named but empty`,
        );
      }
      registry.register(sqlQueryContract);
      executors.push(sqlQueryExecutor(connection));
      enabled.add(ref);
      continue;
    }
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

  // generated OpenAPI tools (030): local spec + config-listed operations only
  for (const entry of config.openapiTools) {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(entry.spec, "utf8"));
    } catch (error) {
      return failBoot(
        `openapi spec ${entry.spec}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const operation of entry.operations) {
      const generated = generateOpenApiTool(
        doc,
        {
          operationId: operation.operationId,
          version: operation.version,
          risk: operation.risk,
          ...(operation.egress !== undefined ? { egress: operation.egress } : {}),
        },
        {
          ...(entry.auth !== undefined ? { auth: entry.auth as OpenApiAuthScheme } : {}),
          ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
        },
      );
      if (!generated.ok) return failBoot(generated.error);
      const ref = refKey(generated.contract);
      const registered = registry.register(generated.contract);
      if (!registered.ok) {
        return failBoot(`openapi tool ${ref} collides with an already-registered tool`);
      }
      executors.push(generated.executor);
      enabled.add(ref);
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
