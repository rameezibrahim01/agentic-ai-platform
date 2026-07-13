import { z } from "zod";

// Form option sources for the agent builder (ticket 053). Read-only views
// over the deployment's mounted configs; the form is convenience, zod on
// the POST is the contract. Missing mounts degrade to documented defaults —
// stub-model, no tools — never a crash: a builder that cannot list options
// still must not take the console down.

/** Loose on purpose: the console lists options from these files, it does
 * not govern them — the worker's strict schemas do. Unknown fields pass. */
const toolsFileSchema = z
  .object({
    tools: z.array(z.string()).default([]),
    mcpServers: z
      .array(
        z.object({
          tools: z
            .array(z.object({ name: z.string(), version: z.string(), risk: z.string() }))
            .default([]),
        }),
      )
      .default([]),
    openapiTools: z
      .array(
        z.object({
          operations: z
            .array(z.object({ operationId: z.string(), version: z.string(), risk: z.string() }))
            .default([]),
        }),
      )
      .default([]),
    sqlTools: z.object({}).passthrough().optional(),
  })
  .passthrough();

const modelsFileSchema = z.object({ allowlist: z.array(z.string()).default([]) }).passthrough();

export interface ToolOption {
  name: string;
  version: string;
  /** Risk when the config declares it; undefined = the form must ask. */
  risk?: string;
}

const REF = /^(.+)@(v[0-9]+)$/;

export async function readToolOptions(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string>,
): Promise<ToolOption[]> {
  const path = env["TOOLS_CONFIG"];
  if (path === undefined || path === "") return [];
  let parsed: z.infer<typeof toolsFileSchema>;
  try {
    parsed = toolsFileSchema.parse(JSON.parse(await read(path)));
  } catch {
    return []; // a broken tools file degrades the PICKER, not the console
  }
  const options: ToolOption[] = [];
  for (const ref of parsed.tools) {
    const match = REF.exec(ref);
    // built-in registry refs carry no risk in the file — the form asks
    if (match) options.push({ name: match[1]!, version: match[2]! });
  }
  for (const server of parsed.mcpServers) {
    for (const tool of server.tools) {
      options.push({ name: tool.name, version: tool.version, risk: tool.risk });
    }
  }
  for (const source of parsed.openapiTools) {
    for (const op of source.operations) {
      options.push({ name: op.operationId, version: op.version, risk: op.risk });
    }
  }
  if (parsed.sqlTools !== undefined) {
    options.push({ name: "sql.query", version: "v1", risk: "read" });
  }
  // stable, deduped by name@version (first declaration wins)
  const seen = new Set<string>();
  return options
    .filter((o) => {
      const key = `${o.name}@${o.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** stub-model is always callable (the hermetic floor); a mounted models
 * config appends its allowlist — same rule as the worker's gateway setup. */
export async function readModelOptions(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string>,
): Promise<string[]> {
  const path = env["MODELS_CONFIG"];
  if (path === undefined || path === "") return ["stub-model"];
  try {
    const parsed = modelsFileSchema.parse(JSON.parse(await read(path)));
    return ["stub-model", ...parsed.allowlist.filter((m) => m !== "stub-model")];
  } catch {
    return ["stub-model"];
  }
}
