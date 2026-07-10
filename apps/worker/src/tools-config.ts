import { z } from "zod";
import { refKey, ToolRegistry } from "@platform/tool-registry";
import type { AgentGrants } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";
import { notesAppendContract, notesAppendExecutor } from "./tools/notes.js";

// Config-driven tool wiring (ticket 021, architecture §6): the worker ships
// with a CATALOG of built-in tool implementations, but registers, grants,
// and allows egress for NOTHING unless the mounted config file says so.
// Which tools exist, who may call them, and where they may reach is
// configuration — never code.

const toolRefSchema = z
  .object({ name: z.string().min(1), version: z.string().min(1) })
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
}

export type BuildToolsResult =
  | { ok: true; tools: BuiltTools }
  | { ok: false; error: string };

/** Parse + validate a tools config document and assemble the gateway inputs. */
export function buildTools(rawConfig: unknown, deps: CatalogDeps): BuildToolsResult {
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
  for (const ref of config.tools) {
    const entry = CATALOG[ref];
    if (entry === undefined) {
      return { ok: false, error: `unknown tool ${ref} — not in this worker's catalog` };
    }
    const made = entry.makeExecutor(deps);
    if (!made.ok) return { ok: false, error: made.error };
    registry.register(entry.contract);
    executors.push(made.executor);
  }

  // grants may only reference enabled tools — a grant to a ghost tool is a
  // config mistake, surfaced at boot rather than as runtime refusals
  const enabled = new Set(config.tools);
  for (const grant of config.grants) {
    for (const tool of grant.tools) {
      if (!enabled.has(refKey(tool))) {
        return {
          ok: false,
          error: `grant for ${grant.agent} references ${refKey(tool)}, which is not enabled`,
        };
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
    },
  };
}
