import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@platform/policy";
import { createToolGateway } from "@platform/tool-gateway";
import { fakeMessage } from "@platform/model-gateway";
import { buildModelGateway } from "../src/model-config.js";
import { describeLaneConfig, resolveLaneConfig } from "../src/tenant-configs.js";
import { buildTools } from "../src/tools-config.js";

// Ticket 041: which tools exist and which models are callable is decided
// PER LANE by that tenant's config file — a tool granted to acme does not
// exist in globex's lane, and this is the pin.

describe("per-lane config resolution (ticket 041)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lane-configs-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matrix: no shared anchor → none; tenant file present → tenant; absent → shared", async () => {
    expect(await resolveLaneConfig(undefined, "tools", "acme")).toEqual({ source: "none" });

    const sharedPath = join(dir, "tools.config.json");
    await writeFile(sharedPath, "{}");
    expect(await resolveLaneConfig(sharedPath, "tools", "acme")).toEqual({
      source: "shared",
      path: sharedPath,
    });

    const acmePath = join(dir, "tools.acme.config.json");
    await writeFile(acmePath, "{}");
    expect(await resolveLaneConfig(sharedPath, "tools", "acme")).toEqual({
      source: "tenant",
      path: acmePath,
    });
    // another tenant is unaffected by acme's override
    expect(await resolveLaneConfig(sharedPath, "tools", "globex")).toEqual({
      source: "shared",
      path: sharedPath,
    });

    expect(describeLaneConfig({ source: "tenant", path: acmePath })).toContain("tenant(");
    expect(describeLaneConfig({ source: "shared", path: sharedPath })).toBe("shared");
    expect(describeLaneConfig({ source: "none" })).toBe("none");
  });
});

describe("tool isolation across lanes (ticket 041)", () => {
  it("a tool enabled+granted only in acme's config executes there and is refused-and-audited in globex's lane", async () => {
    const AGENT = "demo-agent@v1";
    // acme's lane: notes.append enabled and granted
    const acmeBuilt = await buildTools(
      {
        tools: ["notes.append@v1"],
        grants: [{ agent: AGENT, tools: [{ name: "notes.append", version: "v1" }] }],
        egressAllowlist: [],
      },
      { notesFile: join(tmpdir(), "lane-notes.log") },
    );
    expect(acmeBuilt.ok).toBe(true);
    if (!acmeBuilt.ok) return;
    // globex's lane: the shared config — zero tools
    const globexBuilt = await buildTools({ tools: [], grants: [], egressAllowlist: [] }, {});
    expect(globexBuilt.ok).toBe(true);
    if (!globexBuilt.ok) return;

    const lane = (built: typeof acmeBuilt) =>
      createToolGateway({ ...built.tools, rules: DEFAULT_RULES, env: "dev" });
    const acme = lane(acmeBuilt);
    const globex = lane(globexBuilt as typeof acmeBuilt);

    const intent = {
      runId: "run-lane",
      agent: AGENT,
      principal: "user:test",
      intent: { tool: "notes.append", version: "v1", args: { text: "lane isolation" } },
    };
    const inAcme = await acme.handleIntent(intent);
    expect(inAcme.kind).toBe("executed");

    const inGlobex = await globex.handleIntent(intent);
    expect(inGlobex.kind).toBe("refused");
    if (inGlobex.kind === "refused") {
      // the grant check runs first in the pipeline: this lane's config
      // granted nothing, so the intent dies at the gate — and is audited
      expect(inGlobex.reason.code).toBe("not_granted");
    }
  });

  it("a model allowlisted only in acme's config is a typed refusal in globex's lane", () => {
    const stub = [{ kind: "respond" as const, result: fakeMessage("ok") }];
    const acmeBuild = buildModelGateway({
      env: "dev",
      stubScript: stub,
      modelsConfig: {
        allowlist: ["acme-only-model"],
        pricing: { "acme-only-model": { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } },
      },
    });
    expect(acmeBuild.ok).toBe(true);
    if (!acmeBuild.ok) return;
    expect(acmeBuild.allowlist).toContain("acme-only-model");

    const globexBuild = buildModelGateway({ env: "dev", stubScript: stub }); // shared: stub only
    expect(globexBuild.ok).toBe(true);
    if (!globexBuild.ok) return;
    expect(globexBuild.allowlist).not.toContain("acme-only-model");

    // an invalid tenant models config is a BUILD failure — the worker turns
    // this into a boot failure, never a silent fallback to shared
    expect(
      buildModelGateway({
        env: "dev",
        stubScript: stub,
        modelsConfig: { allowlist: ["m"], pricing: {} },
      }),
    ).toMatchObject({ ok: false });
  });
});
