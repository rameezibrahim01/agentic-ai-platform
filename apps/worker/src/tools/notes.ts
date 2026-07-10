import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolContract } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";

// The reference write tool (ticket 021): a real, observable side effect —
// one line appended to a mounted file. It exists so the FULL governed write
// path (registry → grant → policy → approval → executor → audit) ships in
// the artifact; swapping in a partner's system later is configuration, not
// engineering (architecture §6).

export const notesAppendContract: ToolContract = {
  name: "notes.append",
  version: "v1",
  description: "Append one line to the shared notes file (the reference write).",
  risk: "write",
  input: z.object({ text: z.string().min(1).max(2_000) }).strict(),
  output: z.object({ appended: z.literal(true) }).strict(),
  egress: [],
};

/** Line format: `<ISO-8601 UTC> <principal> <text>` (CLAUDE.md #1). */
export function notesAppendExecutor(notesFile: string): ToolExecutor {
  return {
    ref: { name: notesAppendContract.name, version: notesAppendContract.version },
    async execute(args, _secrets, context) {
      const { text } = args as { text: string };
      await mkdir(dirname(notesFile), { recursive: true });
      await appendFile(notesFile, `${new Date().toISOString()} ${context.principal} ${text}\n`, "utf8");
      return { appended: true };
    },
  };
}
