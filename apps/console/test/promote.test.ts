import { describe, expect, it } from "vitest";
import { InMemoryOpsAuditStore } from "@platform/storage";
import { parseAgentsConfig } from "../src/lib/agents";
import {
  evalStatusFor,
  handlePointerMove,
  movePointer,
  pointerGate,
  rollbackPointer,
} from "../src/lib/promote";
import type { PointerDeps } from "../src/lib/promote";
import manifest from "../src/lib/eval-manifest.json";
import { SUITES } from "../../worker/src/evals/cli.js";

// Ticket 055: only pointers move — the same surgery as promote.sh/rollback.sh,
// with one console-specific honesty rule: a version with no in-repo eval
// suite promotes marked "unproven", visibly and in the audit record.
// Rollback is never gated by eval status.

const spec = (id: string) => ({
  id,
  description: `${id} description`,
  prompt: "do the thing",
  model: "stub-model",
  tools: [],
});

const BASE = {
  versions: [spec("triage@v1"), spec("triage@v2"), spec("triage@v3")],
  aliases: {
    triage: { dev: { current: "triage@v2", previous: "triage@v1" }, prod: { current: "triage@v1" } },
  },
};

function config() {
  const parsed = parseAgentsConfig(BASE);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}

describe("pointer surgery (ticket 055)", () => {
  it("promote records the old current as previous; versions are untouched", () => {
    const moved = movePointer(config(), { name: "triage", env: "prod", to: "triage@v3" });
    expect(moved.ok && moved).toMatchObject({ from: "triage@v1", to: "triage@v3" });
    if (!moved.ok) return;
    expect(moved.config.aliases["triage"]?.["prod"]).toEqual({
      current: "triage@v3",
      previous: "triage@v1",
    });
    expect(moved.config.versions).toEqual(config().versions); // pointers only
    expect(moved.config.aliases["triage"]?.["dev"]).toEqual(BASE.aliases.triage.dev); // other envs untouched
  });

  it("promote refusals: unknown alias, unknown version, already-current", () => {
    expect(movePointer(config(), { name: "nope", env: "dev", to: "triage@v1" }).ok).toBe(false);
    expect(movePointer(config(), { name: "triage", env: "dev", to: "ghost@v9" }).ok).toBe(false);
    expect(movePointer(config(), { name: "triage", env: "dev", to: "triage@v2" }).ok).toBe(false);
  });

  it("rollback swaps current/previous and refuses when nothing is recorded", () => {
    const rolled = rollbackPointer(config(), { name: "triage", env: "dev" });
    expect(rolled.ok && rolled).toMatchObject({ from: "triage@v2", to: "triage@v1" });
    if (rolled.ok) {
      expect(rolled.config.aliases["triage"]?.["dev"]).toEqual({
        current: "triage@v1",
        previous: "triage@v2",
      });
      // rollback of the rollback goes forward again — previous is kept
      const again = rollbackPointer(rolled.config, { name: "triage", env: "dev" });
      expect(again.ok && again.to).toBe("triage@v2");
    }
    expect(rollbackPointer(config(), { name: "triage", env: "prod" }).ok).toBe(false); // no previous
    expect(rollbackPointer(config(), { name: "triage", env: "staging" }).ok).toBe(false); // no pointer
  });

  it("gates: dev needs author_agents, prod needs manage_platform", () => {
    expect(pointerGate({ roles: ["agent_developer"] }, "dev")).toBe("admitted");
    expect(pointerGate({ roles: ["agent_developer"] }, "prod")).toBe("forbidden");
    expect(pointerGate({ roles: ["platform_admin"] }, "prod")).toBe("admitted");
    expect(pointerGate({ roles: ["viewer"] }, "dev")).toBe("forbidden");
  });
});

describe("eval manifest (ticket 055)", () => {
  it("MUST NOT drift from the worker's suite registry — regenerate with scripts/evals/gen-console-manifest.sh", () => {
    expect(manifest.agentsWithSuites).toEqual(SUITES.map((s) => s.agent.id));
  });

  it("evalStatusFor: in-repo suites are green-in-CI, everything else is unproven", () => {
    expect(evalStatusFor("demo-agent@v1")).toBe("suite-green-in-ci");
    expect(evalStatusFor("browser-built@v1")).toBe("unproven");
  });
});

describe("handlePointerMove (ticket 055)", () => {
  function makeDeps(overrides: Partial<PointerDeps> = {}) {
    const audit = new InMemoryOpsAuditStore();
    const files = new Map<string, string>([["/etc/agents.json", JSON.stringify(BASE)]]);
    const deps: PointerDeps = {
      session: { principal: "user:op", roles: ["platform_admin"] },
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

  it("a prod promote of an UNPROVEN version succeeds but the marker is in the audit row", async () => {
    const { deps, files, audit } = makeDeps();
    const result = await handlePointerMove(deps, {
      kind: "promote",
      name: "triage",
      env: "prod",
      to: "triage@v3",
    });
    expect(result).toMatchObject({
      status: 200,
      body: { from: "triage@v1", to: "triage@v3", evalStatus: "unproven" },
    });
    expect(JSON.parse(files.get("/etc/agents.json")!).aliases.triage.prod.current).toBe("triage@v3");
    expect(await audit.list()).toEqual([
      expect.objectContaining({
        action: "agent_pointer_promoted",
        detail: expect.objectContaining({ env: "prod", to: "triage@v3", evalStatus: "unproven" }),
      }),
    ]);
  });

  it("an agent_developer moves dev but is refused-and-audited on prod", async () => {
    const { deps, audit } = makeDeps({
      session: { principal: "user:dev", roles: ["agent_developer"] },
    });
    const dev = await handlePointerMove(deps, { kind: "promote", name: "triage", env: "dev", to: "triage@v3" });
    expect(dev.status).toBe(200);
    const prod = await handlePointerMove(deps, { kind: "promote", name: "triage", env: "prod", to: "triage@v3" });
    expect(prod.status).toBe(403);
    expect((await audit.list()).map((row) => row.action)).toEqual([
      "agent_pointer_promoted",
      "agent_pointer_move_refused",
    ]);
  });

  it("rollback is one action, restores previous, and is never eval-gated", async () => {
    const { deps, files, audit } = makeDeps();
    const result = await handlePointerMove(deps, { kind: "rollback", name: "triage", env: "dev" });
    expect(result).toMatchObject({ status: 200, body: { from: "triage@v2", to: "triage@v1" } });
    expect(JSON.parse(files.get("/etc/agents.json")!).aliases.triage.dev).toEqual({
      current: "triage@v1",
      previous: "triage@v2",
    });
    expect((await audit.list())[0]).toMatchObject({ action: "agent_pointer_rolled_back" });
  });

  it("a malformed file refuses the move — the lever never 'fixes' config", async () => {
    const { deps, files } = makeDeps();
    files.set("/etc/agents.json", "{ nope");
    expect((await handlePointerMove(deps, { kind: "rollback", name: "triage", env: "dev" })).status).toBe(409);
    files.set(
      "/etc/agents.json",
      JSON.stringify({ versions: [spec("a@v1")], aliases: { a: { dev: { current: "GHOST@v9" } } } }),
    );
    expect((await handlePointerMove(deps, { kind: "rollback", name: "triage", env: "dev" })).status).toBe(409);
  });

  it("a bad move request is a 400, audited with the reason", async () => {
    const { deps, audit } = makeDeps();
    const result = await handlePointerMove(deps, {
      kind: "promote",
      name: "triage",
      env: "prod",
      to: "ghost@v9",
    });
    expect(result.status).toBe(400);
    expect((await audit.list())[0]).toMatchObject({
      action: "agent_pointer_move_refused",
      detail: expect.objectContaining({ reason: expect.stringContaining("ghost@v9") }),
    });
  });
});
