import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { BudgetPolicy, RunEvent } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import { fakeMessage } from "@platform/model-gateway";
import {
  capBudget,
  checkKillSwitch,
  countRecentStarts,
  limitsConfigSchema,
  makeLimitsLoader,
  makeTenantLimitsLoader,
  NO_LIMITS,
} from "../src/limits.js";
import { makeWorld, TEST_AGENT } from "./helpers.js";

const HOUR = 60 * 60 * 1000;

function startedRun(runId: string, agent: string, at: number): RunEvent[] {
  return [
    { type: "RunStarted", runId, seq: 0, at, agent, principal: "user:x", input: {} },
  ];
}

describe("operator limits (ticket 033)", () => {
  it("config schema: strict, defaults sane, malformed refused", () => {
    expect(limitsConfigSchema.safeParse({}).success).toBe(true);
    const parsed = limitsConfigSchema.parse({});
    expect(parsed.killSwitches).toEqual({ global: false, agents: {}, runs: {} });
    expect(limitsConfigSchema.safeParse({ surprise: true }).success).toBe(false);
    expect(
      limitsConfigSchema.safeParse({ rateLimits: { runsPerHourPerAgent: 0 } }).success,
    ).toBe(false);
  });

  it("kill switch: global beats everything; per-agent hits only that agent", () => {
    expect(checkKillSwitch(NO_LIMITS, "a@v1").tripped).toBe(false);
    const perAgent = { killSwitches: { global: false, agents: { "a@v1": true }, runs: {} } };
    expect(checkKillSwitch(perAgent, "a@v1").tripped).toBe(true);
    expect(checkKillSwitch(perAgent, "b@v1").tripped).toBe(false);
    const global = { killSwitches: { global: true, agents: {}, runs: {} } };
    expect(checkKillSwitch(global, "anything@v9").tripped).toBe(true);
  });

  it("per-run cancel hits only that run; pre-064 files parse unchanged (ticket 064)", () => {
    // a limits file written before the `runs` field existed
    const old = limitsConfigSchema.parse({ killSwitches: { global: false, agents: {} } });
    expect(old.killSwitches.runs).toEqual({});
    expect(checkKillSwitch(old, "a@v1", "run-1").tripped).toBe(false);

    const cancelled = limitsConfigSchema.parse({
      killSwitches: { global: false, agents: {}, runs: { "run-1": true } },
    });
    const hit = checkKillSwitch(cancelled, "a@v1", "run-1");
    expect(hit).toEqual({ tripped: true, detail: "run run-1 was cancelled by an operator" });
    expect(checkKillSwitch(cancelled, "a@v1", "run-2").tripped).toBe(false);
    // the same config without a runId (e.g. older caller) trips nothing
    expect(checkKillSwitch(cancelled, "a@v1").tripped).toBe(false);
  });

  it("property: capBudget is field-wise min — a run never exceeds the platform cap", () => {
    const maybe = fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined });
    const budgetArb = fc.record({
      maxSteps: maybe,
      maxTokens: maybe,
      maxCostUsd: maybe,
      maxWallMs: maybe,
    });
    fc.assert(
      fc.property(budgetArb, budgetArb, (run, cap) => {
        const merged = capBudget(run as BudgetPolicy, cap as BudgetPolicy);
        for (const field of ["maxSteps", "maxTokens", "maxCostUsd", "maxWallMs"] as const) {
          const values = [run[field], cap[field]].filter((v): v is number => v !== undefined);
          expect(merged[field]).toBe(values.length === 0 ? undefined : Math.min(...values));
        }
      }),
    );
    expect(capBudget({ maxSteps: 5 }, undefined)).toEqual({ maxSteps: 5 }); // no cap → untouched
  });

  it("rate window derives from the log alone and slides with the clock", async () => {
    const store = new InMemoryEventStore();
    const now = 10 * HOUR;
    await store.append("r1", 0, startedRun("r1", TEST_AGENT, now - 10_000));
    await store.append("r2", 0, startedRun("r2", TEST_AGENT, now - HOUR + 5_000));
    await store.append("r3", 0, startedRun("r3", TEST_AGENT, now - HOUR - 5_000)); // outside
    await store.append("r4", 0, startedRun("r4", "other@v1", now - 10_000)); // other agent

    expect(await countRecentStarts(store, TEST_AGENT, now)).toBe(2);
    expect(await countRecentStarts(store, TEST_AGENT, now + HOUR)).toBe(0); // window slid
  });

  it("loader: mtime-cached, re-reads on change (the flip needs no restart), malformed fails loud", async () => {
    const dir = await mkdtemp(join(tmpdir(), "limits-"));
    try {
      const path = join(dir, "limits.json");
      await writeFile(path, JSON.stringify({ killSwitches: { global: false, agents: {} } }));
      const load = makeLimitsLoader(path);
      expect((await load()).killSwitches.global).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 10)); // distinct mtime
      await writeFile(path, JSON.stringify({ killSwitches: { global: true, agents: {} } }));
      expect((await load()).killSwitches.global).toBe(true); // reloaded, no restart

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(path, JSON.stringify({ nonsense: 1 }));
      await expect(load()).rejects.toThrow(/LIMITS_CONFIG rejected/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tenant loader (ticket 037): tenant file wins when present, missing falls back, invalid stays loud", async () => {
    const dir = await mkdtemp(join(tmpdir(), "limits-tenant-"));
    try {
      const sharedPath = join(dir, "limits.config.json");
      await writeFile(sharedPath, JSON.stringify({ killSwitches: { global: false, agents: {} } }));
      const tenantPath = join(dir, "limits.acme.config.json");

      const load = makeTenantLimitsLoader(tenantPath, sharedPath);
      expect((await load()).killSwitches.global).toBe(false); // no tenant file → shared

      await writeFile(tenantPath, JSON.stringify({ killSwitches: { global: true, agents: {} } }));
      expect((await load()).killSwitches.global).toBe(true); // tenant override, no restart

      await rm(tenantPath);
      expect((await load()).killSwitches.global).toBe(false); // removal falls back again

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(tenantPath, JSON.stringify({ nonsense: 1 }));
      await expect(load()).rejects.toThrow(/LIMITS_CONFIG rejected/); // never a silent fallback

      // no shared file either: missing tenant file → NO_LIMITS, same as untenanted
      const orphan = makeTenantLimitsLoader(join(dir, "limits.ghost.config.json"), undefined);
      expect(await orphan()).toEqual(NO_LIMITS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checkLimits activity (ticket 033)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function limitsFile(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "limits-act-"));
    dirs.push(dir);
    const path = join(dir, "limits.json");
    await writeFile(path, JSON.stringify(config));
    return path;
  }

  it("no limits configured → every check passes with no caps (all existing worlds unchanged)", async () => {
    const { activities } = makeWorld([{ kind: "respond", result: fakeMessage("hi") }]);
    expect(await activities.checkLimits({ agent: TEST_AGENT, phase: "start" })).toEqual({ ok: true });
    expect(await activities.checkLimits({ agent: TEST_AGENT, phase: "step" })).toEqual({ ok: true });
  });

  it("start phase enforces the rate limit from the log; step phase does not", async () => {
    const path = await limitsFile({
      killSwitches: { global: false, agents: {} },
      rateLimits: { runsPerHourPerAgent: 2 },
    });
    const { store, activities } = makeWorld([{ kind: "respond", result: fakeMessage("hi") }], {
      limitsPath: path,
    });
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await store.append(`r${i}`, 0, startedRun(`r${i}`, TEST_AGENT, now - 1_000 * (i + 1)));
    }
    const refused = await activities.checkLimits({ agent: TEST_AGENT, phase: "start" });
    expect(refused).toMatchObject({ ok: false, reason: "RateLimited" });
    expect(await activities.checkLimits({ agent: TEST_AGENT, phase: "step" })).toEqual({ ok: true });
    expect(await activities.checkLimits({ agent: "other@v1", phase: "start" })).toEqual({ ok: true });
  });

  it("budget caps travel with a passing start check", async () => {
    const path = await limitsFile({
      killSwitches: { global: false, agents: {} },
      budgetCaps: { maxSteps: 3, maxCostUsd: 0.5 },
    });
    const { activities } = makeWorld([{ kind: "respond", result: fakeMessage("hi") }], {
      limitsPath: path,
    });
    expect(await activities.checkLimits({ agent: TEST_AGENT, phase: "start" })).toEqual({
      ok: true,
      budgetCaps: { maxSteps: 3, maxCostUsd: 0.5 },
    });
  });
});
