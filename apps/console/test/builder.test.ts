import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryOpsAuditStore } from "@platform/storage";
import { parseAgentsConfig } from "../src/lib/agents";
import { draftVersion, handleAgentCreate } from "../src/lib/builder";
import type { AgentDraft, CreateDeps } from "../src/lib/builder";
import { loadAgentsConfig } from "../../worker/src/agents/registry.js";
import { readModelOptions, readToolOptions } from "../src/lib/pickers";

// Ticket 053: the builder can only APPEND immutable versions — asserted
// structurally and property-tested, because 028's digest discipline now has
// a second writer to survive. The write path is 047's: validate, refuse
// malformed, audit everything including refusals.

const spec = (id: string) => ({
  id,
  description: `${id} description`,
  prompt: "do the thing",
  model: "stub-model",
  tools: [],
});

const BASE = {
  versions: [spec("triage@v1"), spec("triage@v2")],
  aliases: { triage: { dev: { current: "triage@v2", previous: "triage@v1" }, prod: { current: "triage@v1" } } },
};

const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  name: "helper",
  description: "a helper",
  prompt: "help",
  model: "stub-model",
  tools: [{ name: "notes.append", version: "v1", risk: "write" }],
  ...overrides,
});

function config() {
  const parsed = parseAgentsConfig(BASE);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}

describe("draftVersion (ticket 053)", () => {
  it("a new name mints @v1 and an alias with the DEV pointer only", () => {
    const result = draftVersion(config(), draft());
    expect(result.ok && result.id).toBe("helper@v1");
    if (!result.ok) return;
    expect(result.config.aliases["helper"]).toEqual({ dev: { current: "helper@v1" } });
    expect(result.config.aliases["helper"]?.["prod"]).toBeUndefined();
  });

  it("an existing name mints max+1 and leaves its alias pointers untouched", () => {
    const result = draftVersion(config(), draft({ name: "triage" }));
    expect(result.ok && result.id).toBe("triage@v3");
    if (!result.ok) return;
    expect(result.config.aliases["triage"]).toEqual(BASE.aliases.triage); // pointers move via promotion only
  });

  it("the worker's own loadAgentsConfig accepts what the builder writes", () => {
    const result = draftVersion(config(), draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roundTrip = loadAgentsConfig(JSON.parse(JSON.stringify(result.config)));
    expect(roundTrip.ok).toBe(true);
  });

  it("invalid drafts are refused with the field named", () => {
    const bad = draftVersion(config(), draft({ name: "Not-Valid!" }));
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toContain("name");
    expect(draftVersion(config(), { surprise: 1 }).ok).toBe(false);
    expect(draftVersion(config(), draft({ prompt: "" })).ok).toBe(false);
  });

  it("property: any accepted draft leaves every published version byte-identical", () => {
    const nameArb = fc.constantFrom("triage", "helper", "invoice-bot");
    const draftArb = fc.record({
      name: nameArb,
      description: fc.string({ minLength: 1, maxLength: 30 }),
      prompt: fc.string({ minLength: 1, maxLength: 60 }),
      model: fc.constantFrom("stub-model", "claude-x"),
      tools: fc.array(
        fc.record({
          name: fc.constantFrom("notes.append", "stub.lookup"),
          version: fc.constant("v1"),
          risk: fc.constantFrom("read" as const, "write" as const),
        }),
        { maxLength: 2 },
      ),
    });
    fc.assert(
      fc.property(fc.array(draftArb, { minLength: 1, maxLength: 6 }), (drafts) => {
        let current = config();
        for (const d of drafts) {
          const before = current.versions.map((v) => JSON.stringify(v));
          const result = draftVersion(current, d);
          if (!result.ok) return false;
          const after = result.config.versions.map((v) => JSON.stringify(v));
          // every prior version survives byte-identical, in order
          expect(after.slice(0, before.length)).toEqual(before);
          expect(after).toHaveLength(before.length + 1);
          expect(parseAgentsConfig(JSON.parse(JSON.stringify(result.config))).ok).toBe(true);
          current = result.config;
        }
        return true;
      }),
    );
  });
});

describe("handleAgentCreate (ticket 053)", () => {
  function makeDeps(overrides: Partial<CreateDeps> = {}) {
    const audit = new InMemoryOpsAuditStore();
    const files = new Map<string, string>([["/etc/agents.json", JSON.stringify(BASE)]]);
    const deps: CreateDeps = {
      session: { principal: "user:dev", roles: ["agent_developer"] },
      agentsPath: "/etc/agents.json",
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, content) => {
        files.set(path, content);
      },
      audit,
      nowMs: () => 1_700_000_000_000,
      ...overrides,
    };
    return { deps, files, audit };
  }

  it("a create writes the file (worker-loadable) and lands an ops_audit row", async () => {
    const { deps, files, audit } = makeDeps();
    const result = await handleAgentCreate(deps, draft());
    expect(result).toMatchObject({ status: 200, body: { id: "helper@v1", name: "helper" } });
    const written = JSON.parse(files.get("/etc/agents.json")!);
    expect(loadAgentsConfig(written).ok).toBe(true);
    expect(await audit.list()).toEqual([
      expect.objectContaining({
        principal: "user:dev",
        action: "agent_version_created",
        detail: expect.objectContaining({ id: "helper@v1" }),
      }),
    ]);
  });

  it("a viewer is refused AND audited; the file is untouched", async () => {
    const { deps, files, audit } = makeDeps({
      session: { principal: "user:nosy", roles: ["viewer"] },
    });
    const before = files.get("/etc/agents.json");
    const result = await handleAgentCreate(deps, draft());
    expect(result.status).toBe(403);
    expect(files.get("/etc/agents.json")).toBe(before);
    expect(await audit.list()).toEqual([
      expect.objectContaining({ action: "agent_version_create_refused" }),
    ]);
  });

  it("a malformed current file refuses the write — the builder never 'fixes' config", async () => {
    const { deps, files } = makeDeps();
    files.set("/etc/agents.json", "{ not json");
    expect((await handleAgentCreate(deps, draft())).status).toBe(409);
    files.set("/etc/agents.json", JSON.stringify({ versions: [], aliases: {} }));
    const malformed = await handleAgentCreate(deps, draft());
    expect(malformed.status).toBe(409);
    expect(String(malformed.body["error"])).toContain("malformed");
  });

  it("no registry mounted and read-only filesystems are legible refusals, not crashes", async () => {
    const { deps } = makeDeps({ agentsPath: undefined });
    expect((await handleAgentCreate(deps, draft())).status).toBe(409);

    const readOnly = makeDeps({
      writeFile: async () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    const result = await handleAgentCreate(readOnly.deps, draft());
    expect(result.status).toBe(409);
    expect(String(result.body["error"])).toContain("not writable");
  });

  it("an invalid draft is a 400, audited with the reason", async () => {
    const { deps, audit } = makeDeps();
    const result = await handleAgentCreate(deps, draft({ model: "" }));
    expect(result.status).toBe(400);
    expect(await audit.list()).toEqual([
      expect.objectContaining({
        action: "agent_version_create_refused",
        detail: expect.objectContaining({ reason: expect.stringContaining("model") }),
      }),
    ]);
  });
});

describe("form pickers (ticket 053)", () => {
  it("tool options merge builtin refs (risk unknown), MCP, openapi, and sql tools; missing mount = empty", async () => {
    const toolsFile = JSON.stringify({
      tools: ["notes.append@v1"],
      mcpServers: [{ tools: [{ name: "memo.echo", version: "v1", risk: "read" }] }],
      openapiTools: [{ operations: [{ operationId: "crm.update", version: "v1", risk: "write" }] }],
      sqlTools: { connectionEnv: "SQL_URL" },
    });
    const options = await readToolOptions({ TOOLS_CONFIG: "/t.json" }, async () => toolsFile);
    expect(options).toEqual([
      { name: "crm.update", version: "v1", risk: "write" },
      { name: "memo.echo", version: "v1", risk: "read" },
      { name: "notes.append", version: "v1" },
      { name: "sql.query", version: "v1", risk: "read" },
    ]);
    expect(await readToolOptions({}, async () => toolsFile)).toEqual([]);
    expect(await readToolOptions({ TOOLS_CONFIG: "/t.json" }, async () => "broken")).toEqual([]);
  });

  it("model options are stub-model plus the allowlist; degraded reads never crash", async () => {
    expect(await readModelOptions({}, async () => "")).toEqual(["stub-model"]);
    expect(
      await readModelOptions({ MODELS_CONFIG: "/m.json" }, async () =>
        JSON.stringify({ allowlist: ["claude-x", "stub-model"] }),
      ),
    ).toEqual(["stub-model", "claude-x"]);
    expect(
      await readModelOptions({ MODELS_CONFIG: "/m.json" }, async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual(["stub-model"]);
  });
});
