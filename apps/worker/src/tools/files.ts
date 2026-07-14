import { appendFile, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { ToolContract } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";

// File & spreadsheet connector (ticket 057). Same doctrine as sql.ts (045):
// the tools exist only when config names them, reads are structurally unable
// to write (separate roots, path containment enforced with realpath — never
// string politeness), and the ONE write is an ordinary gateway intent that
// prod pauses for approval. File contents are external data (CLAUDE.md #6):
// they ride results, never instructions.

export const DOCS_LIST_CAP = 200;
export const DOCS_READ_CAP_BYTES = 256 * 1024;
export const SHEET_ROW_CAP = 500;
/** PDFs are parsed in memory — the cap applies BEFORE parsing (ticket 061). */
export const PDF_INPUT_CAP_BYTES = 4 * 1024 * 1024;
export const PDF_NO_TEXT_NOTE =
  "no extractable text — likely a scanned/image-only PDF (OCR is out of scope)";

const TEXT_EXTENSIONS = [".txt", ".md", ".csv", ".json", ".log"];

const relPathSchema = z.string().min(1).max(1_000);

export const docsListContract: ToolContract = {
  name: "docs.list",
  version: "v1",
  description: "List files in the deployment's read-only documents folder.",
  risk: "read",
  input: z.object({ prefix: relPathSchema.optional() }).strict(),
  output: z
    .object({
      files: z.array(
        z.object({ path: z.string(), bytes: z.number().int(), modifiedAt: z.string() }).strict(),
      ),
      truncated: z.boolean(),
    })
    .strict(),
  egress: [],
};

export const docsReadContract: ToolContract = {
  name: "docs.read",
  version: "v1",
  description:
    "Read one document (.txt/.md/.csv/.json/.log, or .pdf text-layer extraction) from the documents folder.",
  risk: "read",
  input: z.object({ path: relPathSchema }).strict(),
  output: z
    .object({
      path: z.string(),
      text: z.string(),
      truncated: z.boolean(),
      provenance: z.literal("external"),
      /** Ticket 061: set for exactly one case — a parseable PDF with no text layer. */
      note: z.string().optional(),
    })
    .strict(),
  egress: [],
};

export const sheetReadContract: ToolContract = {
  name: "sheet.read",
  version: "v1",
  description: "Parse a CSV from the documents folder into header + rows.",
  risk: "read",
  input: z.object({ path: relPathSchema, limit: z.number().int().positive().max(SHEET_ROW_CAP).optional() }).strict(),
  output: z
    .object({
      header: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      truncated: z.boolean(),
      provenance: z.literal("external"),
    })
    .strict(),
  egress: [],
};

export const sheetAppendContract: ToolContract = {
  name: "sheet.append",
  version: "v1",
  description: "Append one row to a CSV in the writable data folder (governed write).",
  risk: "write",
  input: z.object({ path: relPathSchema, row: z.array(z.string().max(2_000)).min(1).max(50) }).strict(),
  output: z.object({ path: z.string(), appended: z.literal(true) }).strict(),
  egress: [],
};

/**
 * Containment, not politeness: reject `..`/absolute inputs up front, then
 * confirm with realpath that the target (or, for creations, its parent)
 * actually lives under the root — a symlink pointing out of the root fails
 * HERE even though the relative path looked innocent.
 */
async function resolveUnder(
  root: string,
  relPath: string,
  { mustExist }: { mustExist: boolean },
): Promise<{ ok: true; abs: string } | { ok: false; error: string }> {
  if (isAbsolute(relPath) || relPath.split(/[/\\]/).includes("..")) {
    return { ok: false, error: `path ${relPath} escapes the configured folder` };
  }
  const rootReal = await realpath(root);
  const abs = resolve(rootReal, relPath);
  const checkTarget = mustExist ? abs : resolve(abs, "..");
  let targetReal: string;
  try {
    targetReal = await realpath(checkTarget);
  } catch {
    return { ok: false, error: `path ${relPath} does not exist under the configured folder` };
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    return { ok: false, error: `path ${relPath} escapes the configured folder` };
  }
  return { ok: true, abs: mustExist ? targetReal : join(targetReal, basename(abs)) };
}

async function walk(
  rootReal: string,
  dir: string,
  out: { path: string; bytes: number; modifiedAt: string }[],
  cap: number,
): Promise<boolean> {
  const entries = (await readdir(dir)).sort();
  for (const name of entries) {
    const abs = join(dir, name);
    const stats = await lstat(abs); // lstat: symlinks are never followed
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      if (await walk(rootReal, abs, out, cap)) return true;
    } else if (stats.isFile()) {
      if (out.length >= cap) return true;
      out.push({
        path: relative(rootReal, abs),
        bytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
  }
  return false;
}

async function readTextCapped(abs: string): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(abs, "r");
  try {
    const stats = await handle.stat();
    const truncated = stats.size > DOCS_READ_CAP_BYTES;
    const buffer = Buffer.alloc(Math.min(stats.size, DOCS_READ_CAP_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export interface FileToolRoots {
  docsDir: string;
  dataDir?: string;
}

export function docsListExecutor(roots: FileToolRoots): ToolExecutor {
  return {
    ref: { name: docsListContract.name, version: docsListContract.version },
    async execute(args) {
      const { prefix } = args as { prefix?: string };
      const rootReal = await realpath(roots.docsDir);
      let start = rootReal;
      if (prefix !== undefined) {
        const resolved = await resolveUnder(roots.docsDir, prefix, { mustExist: true });
        if (!resolved.ok) throw new Error(`docs.list refused: ${resolved.error}`);
        start = resolved.abs;
      }
      const files: { path: string; bytes: number; modifiedAt: string }[] = [];
      const truncated = await walk(rootReal, start, files, DOCS_LIST_CAP);
      return { files, truncated };
    },
  };
}

/** Text-layer extraction only (ticket 061): parseable-but-textless PDFs get
 * the typed note instead of silence; OCR is out of scope, said in-band. */
async function extractPdfText(abs: string): Promise<string> {
  const stats = await lstat(abs);
  if (stats.size > PDF_INPUT_CAP_BYTES) {
    throw new Error(
      `docs.read refused: PDF is ${stats.size} bytes; the parse cap is ${PDF_INPUT_CAP_BYTES}`,
    );
  }
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(abs);
  interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }>;
    destroy(): Promise<void>;
  }
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(params: { data: Uint8Array; verbosity: number }): { promise: Promise<PdfDocument> };
  };
  let doc: PdfDocument;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  } catch (error) {
    throw new Error(`docs.read refused: cannot parse PDF (${(error as Error).message})`);
  }
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const content = await (await doc.getPage(pageNumber)).getTextContent();
      pages.push(content.items.map((item) => item.str ?? "").join(" "));
    }
    return pages.join("\n").trim();
  } finally {
    await doc.destroy();
  }
}

export function docsReadExecutor(roots: FileToolRoots): ToolExecutor {
  return {
    ref: { name: docsReadContract.name, version: docsReadContract.version },
    async execute(args) {
      const { path } = args as { path: string };
      const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
      if (!TEXT_EXTENSIONS.includes(extension) && extension !== ".pdf") {
        throw new Error(
          `docs.read refused: only ${TEXT_EXTENSIONS.join("/")}/.pdf files are readable (got ${path})`,
        );
      }
      const resolved = await resolveUnder(roots.docsDir, path, { mustExist: true });
      if (!resolved.ok) throw new Error(`docs.read refused: ${resolved.error}`);
      if (extension === ".pdf") {
        const extracted = await extractPdfText(resolved.abs);
        const truncated = Buffer.byteLength(extracted, "utf8") > DOCS_READ_CAP_BYTES;
        const text = truncated
          ? Buffer.from(extracted, "utf8").subarray(0, DOCS_READ_CAP_BYTES).toString("utf8")
          : extracted;
        return {
          path,
          text,
          truncated,
          provenance: "external" as const,
          ...(text === "" ? { note: PDF_NO_TEXT_NOTE } : {}),
        };
      }
      const { text, truncated } = await readTextCapped(resolved.abs);
      return { path, text, truncated, provenance: "external" as const };
    },
  };
}

export function sheetReadExecutor(roots: FileToolRoots): ToolExecutor {
  return {
    ref: { name: sheetReadContract.name, version: sheetReadContract.version },
    async execute(args) {
      const { path, limit } = args as { path: string; limit?: number };
      if (!path.toLowerCase().endsWith(".csv")) {
        throw new Error(`sheet.read refused: ${path} is not a .csv file`);
      }
      const resolved = await resolveUnder(roots.docsDir, path, { mustExist: true });
      if (!resolved.ok) throw new Error(`sheet.read refused: ${resolved.error}`);
      const { text } = await readTextCapped(resolved.abs);
      const records = parse(text, {
        relax_column_count: true,
        skip_empty_lines: true,
      }) as string[][];
      const header = records[0] ?? [];
      const cap = Math.min(limit ?? SHEET_ROW_CAP, SHEET_ROW_CAP);
      const body = records.slice(1);
      const truncated = body.length > cap;
      return {
        header,
        rows: truncated ? body.slice(0, cap) : body,
        truncated,
        provenance: "external" as const,
      };
    },
  };
}

export function sheetAppendExecutor(roots: Required<FileToolRoots>): ToolExecutor {
  return {
    ref: { name: sheetAppendContract.name, version: sheetAppendContract.version },
    async execute(args) {
      const { path, row } = args as { path: string; row: string[] };
      if (!path.toLowerCase().endsWith(".csv")) {
        throw new Error(`sheet.append refused: ${path} is not a .csv file`);
      }
      // appends resolve under dataDir ONLY — docsDir is not addressable here
      const resolved = await resolveUnder(roots.dataDir, path, { mustExist: false });
      if (!resolved.ok) throw new Error(`sheet.append refused: ${resolved.error}`);
      await appendFile(resolved.abs, `${row.map(csvEscape).join(",")}\n`, "utf8");
      return { path, appended: true as const };
    },
  };
}
