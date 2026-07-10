import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { demoWriteAgent } from "../src/agents/demo-write.js";
import { nightlyTriageAgent } from "../src/agents/nightly-triage.js";
import { loadAgentsConfig, resolveAgentAlias } from "../src/agents/registry.js";
import type { AgentsConfig } from "../src/agents/registry.js";
import { agentVersionDigest, verifyAgentDigests } from "../src/evals/digests.js";
import { promotePointer, rollbackPointer } from "../src/evals/promote.js";

const CONFIG_PATH = fileURLToPath(new URL("../../../deploy/agents.config.json", import.meta.url));
const DIGESTS_PATH = fileURLToPath(
  new URL("../../../scripts/evals/agent-digests.json", import.meta.url),
);

async function shippedConfig(): Promise<AgentsConfig> {
  const loaded = loadAgentsConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.config;
}

describe("agent registry + pointers (ticket 028)", () => {
  it("the shipped config parses and its registry equals the in-code specs exactly", async () => {
    const config = await shippedConfig();
    expect(config.versions.find((v) => v.id === demoWriteAgent.id)).toEqual(demoWriteAgent);
    expect(config.versions.find((v) => v.id === nightlyTriageAgent.id)).toEqual(nightlyTriageAgent);
  });

  it("alias resolution: env pointers resolve, direct name@vN passes through, unknowns are typed", async () => {
    const config = await shippedConfig();
    const viaAlias = resolveAgentAlias(config, "demo-agent", "prod");
    expect(viaAlias.ok && viaAlias.id).toBe("demo-agent@v1");
    const direct = resolveAgentAlias(config, "nightly-triage@v1", "prod");
    expect(direct.ok && direct.spec.id).toBe("nightly-triage@v1");
    expect(resolveAgentAlias(config, "ghost", "prod").ok).toBe(false);
    expect(resolveAgentAlias(config, "unregistered@v9", "prod").ok).toBe(false);
  });

  it("a pointer at an unregistered version is a load failure, not a runtime surprise", async () => {
    const config = await shippedConfig();
    const broken = {
      ...config,
      aliases: { ...config.aliases, rogue: { prod: { current: "rogue@v1" } } },
    };
    expect(loadAgentsConfig(broken)).toMatchObject({
      ok: false,
      error: expect.stringContaining("rogue@v1"),
    });
  });
});

describe("published-version immutability (ticket 028)", () => {
  it("every shipped version's digest matches the committed digest file", async () => {
    const config = await shippedConfig();
    const recorded = JSON.parse(await readFile(DIGESTS_PATH, "utf8")) as Record<string, string>;
    expect(verifyAgentDigests(config.versions, recorded)).toEqual([]);
  });

  it("mutating a published version is caught; appending a new version is merely unrecorded", async () => {
    const config = await shippedConfig();
    const recorded = JSON.parse(await readFile(DIGESTS_PATH, "utf8")) as Record<string, string>;

    const mutated = { ...demoWriteAgent, prompt: "append TWO drill notes" };
    const caught = verifyAgentDigests([mutated], recorded);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ id: "demo-agent@v1", problem: "changed" });

    const appended = { ...demoWriteAgent, id: "demo-agent@v2" };
    expect(verifyAgentDigests([appended], recorded)).toMatchObject([
      { id: "demo-agent@v2", problem: "unrecorded" },
    ]);
    expect(config.versions.length).toBeGreaterThan(0);
  });

  it("digests are canonical: key order never matters", () => {
    const { id, prompt, ...rest } = demoWriteAgent;
    const reordered = { prompt, ...rest, id } as typeof demoWriteAgent;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(demoWriteAgent));
    expect(agentVersionDigest(reordered)).toBe(agentVersionDigest(demoWriteAgent));
  });
});

describe("promotion + rollback pointer surgery (ticket 028)", () => {
  const base = (): AgentsConfig => ({
    versions: [demoWriteAgent, { ...demoWriteAgent, id: "demo-agent@v2" }],
    aliases: { "demo-agent": { prod: { current: "demo-agent@v1" } } },
  });

  it("promote records the previous version; rollback restores it — and is repeatable", () => {
    const config = base();
    const promoted = promotePointer(config, "demo-agent", "demo-agent@v2", "prod");
    expect(promoted).toMatchObject({ ok: true, from: "demo-agent@v1", to: "demo-agent@v2" });
    expect(config.aliases["demo-agent"]!["prod"]).toEqual({
      current: "demo-agent@v2",
      previous: "demo-agent@v1",
    });

    const rolledBack = rollbackPointer(config, "demo-agent", "prod");
    expect(rolledBack).toMatchObject({ ok: true, from: "demo-agent@v2", to: "demo-agent@v1" });
    expect(config.aliases["demo-agent"]!["prod"]).toEqual({
      current: "demo-agent@v1",
      previous: "demo-agent@v2", // roll-forward stays possible
    });
  });

  it("typed refusals: unregistered target, no-op promote, rollback with no history", () => {
    const config = base();
    expect(promotePointer(config, "demo-agent", "ghost@v9", "prod").ok).toBe(false);
    expect(promotePointer(config, "demo-agent", "demo-agent@v1", "prod").ok).toBe(false);
    expect(rollbackPointer(config, "demo-agent", "prod")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no previous"),
    });
    expect(rollbackPointer(config, "ghost", "prod").ok).toBe(false);
  });
});
