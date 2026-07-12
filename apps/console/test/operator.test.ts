import { describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import { operatorAccess, operatorOverview } from "../src/lib/operator";
import { selectStore } from "../src/lib/tenancy";

// Ticket 042: cross-tenant HEALTH for the operator, never cross-tenant
// browsing. Access is the narrowest useful identity: an untenanted
// platform_admin in a tenanted deployment.

describe("operator access (ticket 042)", () => {
  it("gating matrix: only the untenanted platform_admin in a tenanted deployment", () => {
    expect(operatorAccess({ roles: ["platform_admin"] }, true)).toEqual({ allowed: true });
    expect(operatorAccess({ roles: ["platform_admin"] }, false)).toEqual({
      allowed: false,
      reason: "not_tenanted",
    });
    expect(operatorAccess({ roles: ["viewer"] }, true)).toEqual({
      allowed: false,
      reason: "forbidden",
    });
    expect(operatorAccess({ roles: ["approver", "auditor"] }, true)).toEqual({
      allowed: false,
      reason: "forbidden",
    });
    // a tenant-bound admin manages their tenant, not the platform
    expect(operatorAccess({ roles: ["platform_admin"], tenant: "acme" }, true)).toEqual({
      allowed: false,
      reason: "tenant_bound",
    });
  });

  it("the operator identity still sees NO runs — store selection is the 038 pin", async () => {
    const deps = {
      tenanted: true,
      untenanted: async () => {
        throw new Error("unreachable");
      },
      forTenant: async () => {
        throw new Error("unreachable");
      },
    };
    // an operator session carries no tenant → /runs resolves to nothing
    expect(await selectStore(deps, undefined)).toBeNull();
  });
});

const completedRun = (runId: string, costUsd: number): RunEvent[] => [
  { type: "RunStarted", runId, seq: 0, at: 1, agent: "a@v1", principal: "u", input: {} },
  {
    type: "ModelCalled",
    runId,
    seq: 1,
    at: 2,
    gatewayReqId: "g1",
    model: "m",
    tokensIn: 10,
    tokensOut: 5,
    costUsd,
  },
  { type: "RunCompleted", runId, seq: 2, at: 3, outcome: "done", totalCostUsd: costUsd, steps: 1 },
];

const runningRun = (runId: string): RunEvent[] => [
  { type: "RunStarted", runId, seq: 0, at: 1, agent: "a@v1", principal: "u", input: {} },
];

describe("operator overview (ticket 042)", () => {
  it("per-tenant counts, statuses, cost, and switch state; unreadable is honest", async () => {
    const acme = new InMemoryEventStore();
    await acme.append("run-1", 0, completedRun("run-1", 0.5));
    await acme.append("run-2", 0, completedRun("run-2", 0.25));
    await acme.append("run-3", 0, runningRun("run-3"));
    const globex = new InMemoryEventStore();
    await globex.append("run-g", 0, runningRun("run-g"));

    const rows = await operatorOverview(
      [
        { id: "acme", displayName: "Acme Corp", store: acme },
        { id: "globex", displayName: "Globex", store: globex },
        { id: "initech", displayName: "Initech", store: null }, // key not mounted
      ],
      async (tenantId) =>
        tenantId === "acme"
          ? { global: false, trippedAgents: ["rogue@v1"] }
          : tenantId === "globex"
            ? { global: true, trippedAgents: [] }
            : null,
    );

    expect(rows).toEqual([
      {
        id: "acme",
        displayName: "Acme Corp",
        runs: {
          total: 3,
          byStatus: { completed: 2, running: 1 },
          awaitingApproval: 0,
          costUsd: 0.75,
        },
        killSwitch: { global: false, trippedAgents: ["rogue@v1"] },
      },
      {
        id: "globex",
        displayName: "Globex",
        runs: { total: 1, byStatus: { running: 1 }, awaitingApproval: 0, costUsd: 0 },
        killSwitch: { global: true, trippedAgents: [] },
      },
      {
        id: "initech",
        displayName: "Initech",
        runs: "unreadable",
        killSwitch: "unconfigured",
      },
    ]);
  });

  it("a store that throws on read reports unreadable, never zero", async () => {
    const broken = {
      listRuns: async () => {
        throw new Error("CorruptEventLogError: no key");
      },
    } as unknown as InMemoryEventStore;
    const rows = await operatorOverview(
      [{ id: "acme", displayName: "Acme", store: broken }],
      async () => null,
    );
    expect(rows[0]!.runs).toBe("unreadable");
  });
});
