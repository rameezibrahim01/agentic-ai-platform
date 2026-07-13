import { describe, expect, it } from "vitest";
import {
  agentCatalog,
  baseName,
  catalogRowFor,
  parseAgentsConfig,
  pointerRefs,
  readAgentsConfig,
  versionNumber,
} from "../src/lib/agents";

// Ticket 052: the registry read surface. Pure viewmodels over the same file
// the run starters resolve aliases from — read fresh per request, and a
// malformed file is a typed error, never an empty catalog.

const spec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  description: `${id} description`,
  prompt: "do the thing",
  model: "stub-model",
  tools: [],
  ...extra,
});

const CONFIG = {
  versions: [
    spec("triage@v1"),
    spec("triage@v2", { tools: [{ name: "ticket.update", version: "v1", risk: "write" }] }),
    spec("orphan@v1"),
  ],
  aliases: {
    triage: {
      dev: { current: "triage@v2", previous: "triage@v1" },
      prod: { current: "triage@v1" },
    },
  },
};

describe("agents read surface (ticket 052)", () => {
  it("parses ids: baseName strips @vN, versionNumber orders", () => {
    expect(baseName("triage@v12")).toBe("triage");
    expect(baseName("plain")).toBe("plain");
    expect(versionNumber("triage@v12")).toBe(12);
    expect(versionNumber("plain")).toBe(0);
  });

  it("catalog groups by name, newest first, and keeps alias-less orphans visible", () => {
    const result = readAgentsResult(CONFIG);
    const catalog = agentCatalog(result);
    expect(catalog.map((row) => row.name)).toEqual(["orphan", "triage"]);

    const triage = catalog[1]!;
    expect(triage.aliased).toBe(true);
    expect(triage.versions.map((v) => v.id)).toEqual(["triage@v2", "triage@v1"]);
    expect(triage.envs).toEqual([
      ["dev", { current: "triage@v2", previous: "triage@v1" }],
      ["prod", { current: "triage@v1" }],
    ]);

    const orphan = catalog[0]!;
    expect(orphan.aliased).toBe(false);
    expect(orphan.envs).toEqual([]);
  });

  it("pointerRefs names every env that references a version, current and previous", () => {
    const row = catalogRowFor(readAgentsResult(CONFIG), "triage")!;
    expect(pointerRefs(row, "triage@v2")).toEqual(["dev (current)"]);
    expect(pointerRefs(row, "triage@v1")).toEqual([
      "dev (previous — what rollback restores)",
      "prod (current)",
    ]);
    expect(pointerRefs(row, "triage@v9")).toEqual([]);
  });

  it("not-configured, unreadable, and invalid are three distinct typed results", async () => {
    const read = async () => JSON.stringify(CONFIG);
    expect(await readAgentsConfig({}, read)).toEqual({ ok: false, kind: "not-configured" });

    const boom = async () => {
      throw new Error("ENOENT");
    };
    const unreadable = await readAgentsConfig({ AGENTS_CONFIG: "/nope.json" }, boom);
    expect(unreadable).toMatchObject({ ok: false, kind: "unreadable" });
    if (!unreadable.ok && unreadable.kind !== "not-configured") {
      expect(unreadable.error).toContain("/nope.json");
    }

    const invalid = await readAgentsConfig({ AGENTS_CONFIG: "/x.json" }, async () =>
      JSON.stringify({ versions: [spec("a@v1")], aliases: {}, surprise: 1 }),
    );
    expect(invalid).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("a pointer at an unregistered version is INVALID, not a blank row — same rule as the worker", async () => {
    const dangling = {
      versions: [spec("a@v1")],
      aliases: { a: { dev: { current: "a@v2" } } },
    };
    const result = await readAgentsConfig({ AGENTS_CONFIG: "/x.json" }, async () =>
      JSON.stringify(dangling),
    );
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (!result.ok && result.kind === "invalid") expect(result.error).toContain("a@v2");
  });

  it("reads are per-request fresh: a changed file changes the next result", async () => {
    let content = JSON.stringify(CONFIG);
    const read = async () => content;
    const env = { AGENTS_CONFIG: "/etc/platform/agents.config.json" };

    const first = await readAgentsConfig(env, read);
    expect(first.ok && first.config.versions).toHaveLength(3);

    content = JSON.stringify({
      ...CONFIG,
      versions: [...CONFIG.versions, spec("triage@v3")],
    });
    const second = await readAgentsConfig(env, read);
    expect(second.ok && second.config.versions).toHaveLength(4);
  });
});

// route the fixture through the real parser so tests exercise the schema
function readAgentsResult(raw: unknown) {
  const parsed = parseAgentsConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}
