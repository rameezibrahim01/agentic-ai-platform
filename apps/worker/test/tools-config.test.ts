import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTools } from "../src/tools-config.js";
import { notesAppendExecutor } from "../src/tools/notes.js";

const VALID = {
  tools: ["notes.append@v1"],
  grants: [{ agent: "demo-agent@v1", tools: [{ name: "notes.append", version: "v1" }] }],
  egressAllowlist: [],
};

describe("config-driven tool wiring (ticket 021)", () => {
  it("a valid config assembles registry, grants, executors, egress — from config alone", async () => {
    const built = await buildTools(VALID, { notesFile: "/data/notes/notes.log" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.tools.registry.describeAll().map((t) => `${t.name}@${t.version}`)).toEqual([
      "notes.append@v1",
    ]);
    expect(built.tools.registry.describe({ name: "notes.append", version: "v1" })).toMatchObject({
      risk: "write",
      egress: [],
    });
    expect(built.tools.grants).toEqual(VALID.grants);
    expect(built.tools.executors).toHaveLength(1);
    expect(built.tools.egressAllowlist).toEqual([]);
  });

  it("boot-time refusals: unknown catalog ref, missing NOTES_FILE, grant to a ghost tool, bad shape", async () => {
    const unknown = await buildTools({ ...VALID, tools: ["shell.exec@v1"] }, { notesFile: "/n" });
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("shell.exec@v1") });

    const noFile = await buildTools(VALID, {});
    expect(noFile).toMatchObject({ ok: false, error: expect.stringContaining("NOTES_FILE") });

    const ghostGrant = await buildTools(
      { ...VALID, grants: [{ agent: "a@v1", tools: [{ name: "other.tool", version: "v1" }] }] },
      { notesFile: "/n" },
    );
    expect(ghostGrant).toMatchObject({ ok: false, error: expect.stringContaining("other.tool@v1") });

    expect((await buildTools({ tools: "notes.append@v1" }, {})).ok).toBe(false);
    expect((await buildTools({ ...VALID, extra: true }, { notesFile: "/n" })).ok).toBe(false); // strict
  });

  it("an empty tools list is a legal zero-tool deployment (everything refused at the gateway)", async () => {
    const built = await buildTools({ tools: [], grants: [], egressAllowlist: [] }, {});
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.tools.registry.describeAll()).toEqual([]);
      expect(built.tools.executors).toEqual([]);
    }
  });
});

describe("notes.append executor (the reference write)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("appends `<ISO-8601 UTC> <principal> <text>` and reports appended", async () => {
    dir = await mkdtemp(join(tmpdir(), "notes-drill-"));
    const notesFile = join(dir, "sub", "notes.log");
    const executor = notesAppendExecutor(notesFile);

    const result = await executor.execute({ text: "hello from the drill" }, {}, {
      runId: "r1",
      agent: "demo-agent@v1",
      principal: "user:demo",
    });
    expect(result).toEqual({ appended: true });
    await executor.execute({ text: "second line" }, {}, {
      runId: "r2",
      agent: "demo-agent@v1",
      principal: "user:ops",
    });

    const lines = (await readFile(notesFile, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z user:demo hello from the drill$/,
    );
    expect(lines[1]).toMatch(/Z user:ops second line$/);
  });
});
