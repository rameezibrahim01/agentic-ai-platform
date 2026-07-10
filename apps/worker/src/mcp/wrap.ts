import { z, type ZodTypeAny } from "zod";
import type { RiskTier } from "@platform/core";
import type { ToolContract } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";
import type { McpCallResult, McpServerTool, McpStdioClient } from "./client.js";

// Wrapping (ticket 024, architecture §6): the moment an MCP server's tool is
// wrapped it inherits the entire governance stack. Trust is explicit — the
// deployment config names each tool and assigns its risk tier; NOTHING the
// server advertises carries authority. Unconvertible input schemas are a
// boot failure, never a silently-permissive validator.

export interface McpToolConfig {
  /** Must match a tool the server advertises. */
  name: string;
  version: string;
  risk: RiskTier;
  description?: string;
  egress: readonly string[];
}

type Converted = { ok: true; schema: ZodTypeAny } | { ok: false; error: string };

/** Minimal JSON-Schema → zod conversion; anything unsupported fails loudly. */
export function jsonSchemaToZod(schema: unknown, path = "$"): Converted {
  if (typeof schema !== "object" || schema === null) {
    return { ok: false, error: `${path}: schema must be an object` };
  }
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s["enum"])) {
    const values = s["enum"];
    if (!values.every((v): v is string => typeof v === "string") || values.length === 0) {
      return { ok: false, error: `${path}: only non-empty string enums are supported` };
    }
    return { ok: true, schema: z.enum(values as [string, ...string[]]) };
  }

  switch (s["type"]) {
    case "string": {
      let str = z.string();
      if (typeof s["minLength"] === "number") str = str.min(s["minLength"]);
      if (typeof s["maxLength"] === "number") str = str.max(s["maxLength"]);
      return { ok: true, schema: str };
    }
    case "number":
      return { ok: true, schema: z.number() };
    case "integer":
      return { ok: true, schema: z.number().int() };
    case "boolean":
      return { ok: true, schema: z.boolean() };
    case "array": {
      const items = jsonSchemaToZod(s["items"] ?? {}, `${path}.items`);
      return items.ok ? { ok: true, schema: z.array(items.schema) } : items;
    }
    case "object": {
      const properties = (s["properties"] ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s["required"]) ? (s["required"] as string[]) : []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const converted = jsonSchemaToZod(value, `${path}.${key}`);
        if (!converted.ok) return converted;
        shape[key] = required.has(key) ? converted.schema : converted.schema.optional();
      }
      const object = z.object(shape);
      // additionalProperties: anything but an explicit `true` means strict —
      // permissive-by-default is how injected arguments sneak past contracts
      return { ok: true, schema: s["additionalProperties"] === true ? object.passthrough() : object.strict() };
    }
    default:
      return { ok: false, error: `${path}: unsupported schema type ${JSON.stringify(s["type"])}` };
  }
}

/** MCP tool results are content blocks; anything else never passes unlabeled. */
export const mcpContentSchema = z
  .object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    isError: z.boolean().optional(),
  })
  .passthrough();

export type WrapResult =
  | { ok: true; contract: ToolContract; executor: ToolExecutor }
  | { ok: false; error: string };

export function wrapMcpTool(
  client: McpStdioClient,
  advertised: McpServerTool,
  config: McpToolConfig,
): WrapResult {
  const input = jsonSchemaToZod(advertised.inputSchema);
  if (!input.ok) {
    return { ok: false, error: `mcp tool ${config.name}: input schema unconvertible — ${input.error}` };
  }
  const contract: ToolContract = {
    name: config.name,
    version: config.version,
    description: config.description ?? advertised.description ?? `MCP tool ${config.name}`,
    risk: config.risk, // assigned by config, NEVER taken from the server
    input: input.schema,
    output: mcpContentSchema,
    egress: [...config.egress],
  };
  const executor: ToolExecutor = {
    ref: { name: config.name, version: config.version },
    async execute(args) {
      const result: McpCallResult = await client.callTool(
        advertised.name,
        args as Record<string, unknown>,
      );
      if (result.isError) {
        // a server-reported failure is a ToolFailed refusal, not a result
        const text = result.content?.map((c) => c.text ?? "").join(" ") ?? "";
        throw new Error(`mcp tool ${advertised.name} failed: ${text}`.trim());
      }
      return result;
    },
  };
  return { ok: true, contract, executor };
}
