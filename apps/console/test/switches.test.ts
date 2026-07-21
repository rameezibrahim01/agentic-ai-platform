import { describe, expect, it } from "vitest";
import { InMemoryOpsAuditStore } from "@platform/storage";
import { flipSwitch, handleSwitchFlip, switchWriteTarget } from "../src/lib/switches";
import type { FlipDeps } from "../src/lib/switches";

// Ticket 047: the ONE console write action — flip a switch — gated, scoped,
// atomic-ish, and AUDITED, refusals included.

const OFF = { killSwitches: { global: false, agents: {} } };

describe("flip logic (ticket 047)", () => {
  it("flips global and per-agent, preserving everything else", () => {
    const withCaps = { ...OFF, budgetCaps: { maxSteps: 5 } };
    const globalOn = flipSwitch(withCaps, { scope: "global", tripped: true });
    expect(globalOn).toMatchObject({
      ok: true,
      from: false,
      to: true,
      config: { killSwitches: { global: true, agents: {} }, budgetCaps: { maxSteps: 5 } },
    });

    const agentOn = flipSwitch(OFF, { scope: "agent", agent: "rogue@v1", tripped: true });
    expect(agentOn.ok && agentOn.config.killSwitches.agents).toEqual({ "rogue@v1": true });
    const agentOff = flipSwitch(
      agentOn.ok ? agentOn.config : OFF,
      { scope: "agent", agent: "rogue@v1", tripped: false },
    );
    expect(agentOff).toMatchObject({ ok: true, from: true, to: false });
  });

  it("a malformed current file refuses the flip — the lever never 'fixes' config", () => {
    expect(flipSwitch({ nonsense: 1 }, { scope: "global", tripped: true }).ok).toBe(false);
    expect(flipSwitch(OFF, { scope: "agent", agent: "", tripped: true }).ok).toBe(false);
  });
});

describe("per-run cancel (ticket 064)", () => {
  it("flips a run switch; files written before the field parse and flip unchanged", () => {
    // OFF has no `runs` key — the pre-064 shape
    const on = flipSwitch(OFF, { scope: "run", runId: "run-7", tripped: true });
    expect(on).toMatchObject({ ok: true, from: false, to: true });
    expect(on.ok && on.config.killSwitches.runs).toEqual({ "run-7": true });
    expect(on.ok && on.config.killSwitches.agents).toEqual({});
    expect(flipSwitch(OFF, { scope: "run", runId: "", tripped: true }).ok).toBe(false);
  });

  it("the flip prunes entries for finished runs, keeps live and unknown ones", async () => {
    const seeded = {
      killSwitches: {
        global: false,
        agents: {},
        runs: { "run-done": true, "run-live": true, "run-unknown": true },
      },
    };
    const { deps, files, audit } = makeDeps();
    files.set("/cfg/limits.config.json", JSON.stringify(seeded));
    deps.runIsTerminal = async (runId) => {
      if (runId === "run-done") return true;
      if (runId === "run-live") return false;
      throw new Error("status unreadable");
    };
    const result = await handleSwitchFlip(deps, { scope: "run", runId: "run-new", tripped: true });
    expect(result.status).toBe(200);
    expect(JSON.parse(files.get("/cfg/limits.config.json")!).killSwitches.runs).toEqual({
      "run-new": true,
      "run-live": true,
      "run-unknown": true, // unreadable status — kept, best-effort doctrine
    });
    expect((await audit.list())[0]).toMatchObject({
      action: "kill_switch_flip",
      detail: { switch: "run:run-new", from: false, to: true },
    });
  });
});

describe("write-target matrix (ticket 047)", () => {
  const admin = { roles: ["platform_admin" as const] };
  it("untenanted: admin flips shared; tenant params refused; non-admin refused", () => {
    expect(switchWriteTarget(admin, false, undefined)).toEqual({ ok: true, target: "shared" });
    expect(switchWriteTarget(admin, false, "acme")).toEqual({
      ok: false,
      reason: "tenant_param_untenanted",
    });
    expect(switchWriteTarget({ roles: ["viewer" as const] }, false, undefined)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(switchWriteTarget({ roles: ["approver" as const] }, true, undefined)).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("tenanted: a tenant admin flips only their lane; the operator names lanes or the shared file", () => {
    const tenantAdmin = { roles: ["platform_admin" as const], tenant: "acme" };
    expect(switchWriteTarget(tenantAdmin, true, undefined)).toEqual({
      ok: true,
      target: { tenant: "acme" },
    });
    expect(switchWriteTarget(tenantAdmin, true, "acme")).toEqual({
      ok: true,
      target: { tenant: "acme" },
    });
    expect(switchWriteTarget(tenantAdmin, true, "globex")).toEqual({
      ok: false,
      reason: "cross_tenant",
    });
    // the 042 operator identity
    expect(switchWriteTarget(admin, true, undefined)).toEqual({ ok: true, target: "shared" });
    expect(switchWriteTarget(admin, true, "globex")).toEqual({
      ok: true,
      target: { tenant: "globex" },
    });
  });
});

function makeDeps(overrides: Partial<FlipDeps> = {}) {
  const files = new Map<string, string>([["/cfg/limits.config.json", JSON.stringify(OFF)]]);
  const audit = new InMemoryOpsAuditStore();
  const deps: FlipDeps = {
    session: { principal: "user:admin", roles: ["platform_admin"] },
    tenanted: false,
    sharedPath: "/cfg/limits.config.json",
    pathFor: (target) =>
      target === "shared" ? "/cfg/limits.config.json" : `/cfg/limits.${target.tenant}.config.json`,
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

describe("the write path end to end (ticket 047)", () => {
  it("a flip writes the file and lands an ops_audit row (who/what/old→new/file)", async () => {
    const { deps, files, audit } = makeDeps();
    const result = await handleSwitchFlip(deps, { scope: "global", tripped: true });
    expect(result.status).toBe(200);
    expect(JSON.parse(files.get("/cfg/limits.config.json")!)).toMatchObject({
      killSwitches: { global: true },
    });
    expect(await audit.list()).toEqual([
      {
        at: 1_700_000_000_000,
        principal: "user:admin",
        action: "kill_switch_flip",
        scope: "shared",
        detail: { switch: "global", from: false, to: true, file: "/cfg/limits.config.json" },
      },
    ]);
  });

  it("a refused flip writes NOTHING to the file and IS audited", async () => {
    const { deps, files, audit } = makeDeps({
      session: { principal: "user:viewer", roles: ["viewer"] },
    });
    const before = files.get("/cfg/limits.config.json");
    const result = await handleSwitchFlip(deps, { scope: "global", tripped: true });
    expect(result.status).toBe(403);
    expect(files.get("/cfg/limits.config.json")).toBe(before);
    const rows = await audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal: "user:viewer",
      action: "kill_switch_flip_refused",
      detail: { reason: "forbidden" },
    });
  });

  it("tenant lanes: the admin's flip targets their lane file; a missing lane file is a 409 with instructions", async () => {
    const { deps, files } = makeDeps({
      session: { principal: "user:t-admin", roles: ["platform_admin"], tenant: "acme" },
      tenanted: true,
    });
    // lane file absent → refuse (a container cannot conjure a mount)
    const missing = await handleSwitchFlip(deps, { scope: "global", tripped: true });
    expect(missing.status).toBe(409);

    files.set("/cfg/limits.acme.config.json", JSON.stringify(OFF));
    const result = await handleSwitchFlip(deps, {
      scope: "agent",
      agent: "rogue@v1",
      tripped: true,
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(files.get("/cfg/limits.acme.config.json")!)).toMatchObject({
      killSwitches: { agents: { "rogue@v1": true } },
    });
    expect(JSON.parse(files.get("/cfg/limits.config.json")!)).toEqual(OFF); // shared untouched
  });

  it("no LIMITS_CONFIG and malformed files are typed 409s, nothing written", async () => {
    const noConfig = makeDeps({ sharedPath: undefined });
    expect((await handleSwitchFlip(noConfig.deps, { scope: "global", tripped: true })).status).toBe(
      409,
    );

    const { deps, files } = makeDeps();
    files.set("/cfg/limits.config.json", "{not json");
    const malformed = await handleSwitchFlip(deps, { scope: "global", tripped: true });
    expect(malformed.status).toBe(409);
    expect(files.get("/cfg/limits.config.json")).toBe("{not json");
  });
});
