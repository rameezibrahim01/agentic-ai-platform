import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@platform/policy";
import { createToolGateway } from "@platform/tool-gateway";
import {
  DOCS_LIST_CAP,
  DOCS_READ_CAP_BYTES,
  docsListExecutor,
  docsReadExecutor,
  PDF_INPUT_CAP_BYTES,
  PDF_NO_TEXT_NOTE,
  SHEET_ROW_CAP,
  sheetAppendExecutor,
  sheetReadExecutor,
} from "../src/tools/files.js";
import { buildTools } from "../src/tools-config.js";

// Ticket 057: the file connector. Reads are structurally unable to write
// (separate roots + realpath containment), every surface is capped, and the
// ONE write pauses for approval in prod like any governed intent.

let docsDir: string;
let dataDir: string;
let outsideDir: string;

beforeAll(async () => {
  docsDir = await mkdtemp(join(tmpdir(), "docs-"));
  dataDir = await mkdtemp(join(tmpdir(), "sheets-"));
  outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
  await writeFile(join(docsDir, "memo.txt"), "vendor rate changed", "utf8");
  await writeFile(
    join(docsDir, "invoices.csv"),
    'invoice_id,vendor,amount\nINV-1,"Gulf IT, FZE",100.50\nINV-2,"says ""hi""\nsecond line",7\n',
    "utf8",
  );
  await mkdir(join(docsDir, "sub"));
  await writeFile(join(docsDir, "sub", "notes.md"), "# nested", "utf8");
  await writeFile(join(docsDir, "binary.bin"), Buffer.from([0, 1, 2]), "utf8");
  await writeFile(join(outsideDir, "secret.txt"), "outside the root", "utf8");
  await symlink(join(outsideDir, "secret.txt"), join(docsDir, "sneaky.txt"));
});

afterAll(async () => {
  for (const dir of [docsDir, dataDir, outsideDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

const roots = () => ({ docsDir, dataDir });

describe("docs.list / docs.read (ticket 057)", () => {
  it("lists files recursively without following symlinks", async () => {
    const result = (await docsListExecutor(roots()).execute({}, {} as never)) as {
      files: { path: string }[];
      truncated: boolean;
    };
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("memo.txt");
    expect(paths).toContain(join("sub", "notes.md"));
    expect(paths).not.toContain("sneaky.txt"); // symlinks are never followed
    expect(result.truncated).toBe(false);
  });

  it("caps the listing and says so", async () => {
    const bulk = await mkdtemp(join(tmpdir(), "bulk-"));
    try {
      for (let i = 0; i < DOCS_LIST_CAP + 5; i += 1) {
        await writeFile(join(bulk, `f-${String(i).padStart(4, "0")}.txt`), "x", "utf8");
      }
      const result = (await docsListExecutor({ docsDir: bulk }).execute({}, {} as never)) as {
        files: unknown[];
        truncated: boolean;
      };
      expect(result.files).toHaveLength(DOCS_LIST_CAP);
      expect(result.truncated).toBe(true);
    } finally {
      await rm(bulk, { recursive: true, force: true });
    }
  });

  it("reads text files with the byte cap; refuses traversal, symlink escapes, and binaries", async () => {
    const read = docsReadExecutor(roots());
    const memo = (await read.execute({ path: "memo.txt" }, {} as never)) as {
      text: string;
      truncated: boolean;
      provenance: string;
    };
    expect(memo).toMatchObject({ text: "vendor rate changed", truncated: false, provenance: "external" });

    await expect(read.execute({ path: "../secret.txt" }, {} as never)).rejects.toThrow(/escapes/);
    await expect(read.execute({ path: "/etc/passwd" }, {} as never)).rejects.toThrow(/escapes|readable/);
    await expect(read.execute({ path: "sneaky.txt" }, {} as never)).rejects.toThrow(/escapes/);
    await expect(read.execute({ path: "binary.bin" }, {} as never)).rejects.toThrow(/readable/);

    const big = "x".repeat(DOCS_READ_CAP_BYTES + 100);
    await writeFile(join(docsDir, "big.log"), big, "utf8");
    const capped = (await read.execute({ path: "big.log" }, {} as never)) as {
      text: string;
      truncated: boolean;
    };
    expect(capped.truncated).toBe(true);
    expect(capped.text).toHaveLength(DOCS_READ_CAP_BYTES);
  });
});

describe("docs.read on PDFs (ticket 061)", () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

  it("extracts the text layer from a real PDF, provenance-labeled, note-free", async () => {
    await copyFile(join(fixtures, "fixture-061.pdf"), join(docsDir, "invoice.pdf"));
    const result = (await docsReadExecutor(roots()).execute({ path: "invoice.pdf" }, {} as never)) as {
      text: string;
      truncated: boolean;
      provenance: string;
      note?: string;
    };
    expect(result.text).toContain("PLATFORM PDF FIXTURE 061");
    expect(result).toMatchObject({ truncated: false, provenance: "external" });
    expect(result.note).toBeUndefined();
  });

  it("a parseable PDF with no text layer yields empty text WITH the typed note", async () => {
    await copyFile(join(fixtures, "fixture-061-notext.pdf"), join(docsDir, "scan.pdf"));
    const result = (await docsReadExecutor(roots()).execute({ path: "scan.pdf" }, {} as never)) as {
      text: string;
      note?: string;
    };
    expect(result.text).toBe("");
    expect(result.note).toBe(PDF_NO_TEXT_NOTE);
  });

  it("corrupt and oversized PDFs are typed refusals; containment still holds for .pdf", async () => {
    await writeFile(join(docsDir, "broken.pdf"), "%PDF-1.4 this is not a pdf", "utf8");
    await expect(
      docsReadExecutor(roots()).execute({ path: "broken.pdf" }, {} as never),
    ).rejects.toThrow(/cannot parse PDF/);

    await writeFile(join(docsDir, "huge.pdf"), Buffer.alloc(PDF_INPUT_CAP_BYTES + 1), "utf8");
    await expect(
      docsReadExecutor(roots()).execute({ path: "huge.pdf" }, {} as never),
    ).rejects.toThrow(/parse cap/);

    await expect(
      docsReadExecutor(roots()).execute({ path: "../escape.pdf" }, {} as never),
    ).rejects.toThrow(/escapes/);
  });
});

describe("sheet.read / sheet.append (ticket 057)", () => {
  it("parses quoted commas, escaped quotes, and embedded newlines", async () => {
    const result = (await sheetReadExecutor(roots()).execute({ path: "invoices.csv" }, {} as never)) as {
      header: string[];
      rows: string[][];
      truncated: boolean;
    };
    expect(result.header).toEqual(["invoice_id", "vendor", "amount"]);
    expect(result.rows).toEqual([
      ["INV-1", "Gulf IT, FZE", "100.50"],
      ["INV-2", 'says "hi"\nsecond line', "7"],
    ]);
    expect(result.truncated).toBe(false);
  });

  it("caps rows and refuses non-CSV paths", async () => {
    const lines = ["id", ...Array.from({ length: SHEET_ROW_CAP + 10 }, (_, i) => String(i))];
    await writeFile(join(docsDir, "long.csv"), `${lines.join("\n")}\n`, "utf8");
    const capped = (await sheetReadExecutor(roots()).execute({ path: "long.csv" }, {} as never)) as {
      rows: unknown[];
      truncated: boolean;
    };
    expect(capped.rows).toHaveLength(SHEET_ROW_CAP);
    expect(capped.truncated).toBe(true);
    await expect(
      sheetReadExecutor(roots()).execute({ path: "memo.txt" }, {} as never),
    ).rejects.toThrow(/not a .csv/);
  });

  it("append writes ONE escaped row under dataDir and cannot reach anywhere else", async () => {
    const append = sheetAppendExecutor({ docsDir, dataDir });
    await append.execute(
      { path: "findings.csv", row: ["INV-2", 'flag: "quoted", comma', "line1\nline2"] },
      {} as never,
    );
    const written = await readFile(join(dataDir, "findings.csv"), "utf8");
    expect(written).toBe('INV-2,"flag: ""quoted"", comma","line1\nline2"\n');
    // round-trip: our escaping is csv-parse's dialect
    const back = (await sheetReadExecutor({ docsDir: dataDir }).execute(
      { path: "findings.csv" },
      {} as never,
    )) as { header: string[] };
    expect(back.header).toEqual(["INV-2", 'flag: "quoted", comma', "line1\nline2"]);

    await expect(
      append.execute({ path: "../escape.csv", row: ["x"] }, {} as never),
    ).rejects.toThrow(/escapes/);
    await expect(append.execute({ path: "notes.txt", row: ["x"] }, {} as never)).rejects.toThrow(
      /not a .csv/,
    );
  });
});

describe("boot wiring (ticket 057)", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    tools: ["docs.list@v1", "docs.read@v1", "sheet.read@v1", "sheet.append@v1"],
    grants: [
      {
        agent: "filer@v1",
        tools: [
          { name: "docs.read", version: "v1" },
          { name: "sheet.append", version: "v1" },
        ],
      },
    ],
    fileTools: { docsDir, dataDir },
    ...overrides,
  });

  it("boots all four tools from config; refuses missing config, missing dirs, and append without dataDir", async () => {
    const built = await buildTools(config(), {});
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.tools.registry.describeAll().map((t) => t.name).sort()).toEqual([
        "docs.list",
        "docs.read",
        "sheet.append",
        "sheet.read",
      ]);
    }

    const noSection = await buildTools(config({ fileTools: undefined }), {});
    expect(noSection).toMatchObject({ ok: false, error: expect.stringContaining("fileTools") });

    const ghostDir = await buildTools(
      config({ fileTools: { docsDir: join(docsDir, "nope"), dataDir } }),
      {},
    );
    expect(ghostDir).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });

    const noData = await buildTools(config({ fileTools: { docsDir } }), {});
    expect(noData).toMatchObject({
      ok: false,
      error: expect.stringContaining("fileTools.dataDir"),
    });
  });

  it("environment split, connector edition: sheet.append auto-executes in dev and PAUSES in prod", async () => {
    const intent = {
      runId: "run-file",
      agent: "filer@v1",
      principal: "user:test",
      intent: { tool: "sheet.append", version: "v1", args: { path: "split.csv", row: ["a"] } },
    };
    const built = await buildTools(config(), {});
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const dev = createToolGateway({ ...built.tools, rules: DEFAULT_RULES, env: "dev" });
    const executed = await dev.handleIntent(intent);
    expect(executed.kind).toBe("executed");

    const prod = createToolGateway({ ...built.tools, rules: DEFAULT_RULES, env: "prod" });
    const paused = await prod.handleIntent(intent);
    expect(paused.kind).toBe("approval_required");

    // reads auto-execute even in prod — the read/write split is the doctrine
    const read = await prod.handleIntent({
      ...intent,
      intent: { tool: "docs.read", version: "v1", args: { path: "memo.txt" } },
    });
    expect(read.kind).toBe("executed");
  });
});
