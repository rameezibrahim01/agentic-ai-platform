import { describe, expect, it } from "vitest";
import type { RunEvent } from "@platform/core";
import { InMemoryEventStore } from "@platform/storage";
import type { EventStore } from "@platform/storage";
import {
  consoleTenantsSchema,
  decideApprovalSignal,
  schemaForTenant,
  selectStore,
  workflowIdFor,
} from "../src/lib/tenancy";

// Ticket 038: the console must not be where storage/engine isolation leaks
// back together. These tests pin the two pure decisions every surface goes
// through: which store a session sees, and whether a signal may leave.

const started = (runId: string): RunEvent[] => [
  {
    type: "RunStarted",
    runId,
    seq: 0,
    at: 1_700_000_000_000,
    agent: "stub-agent@v1",
    principal: "user:test",
    input: {},
  },
];

async function seeded(runId: string): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  await store.append(runId, 0, started(runId));
  return store;
}

describe("tenants config + naming (ticket 038)", () => {
  it("mirrors the worker: strict schema, slug ids, deterministic names", () => {
    expect(
      consoleTenantsSchema.safeParse({
        tenants: [{ id: "acme", displayName: "Acme", dataKeyEnv: "ACME_KEY" }],
      }).success,
    ).toBe(true);
    expect(consoleTenantsSchema.safeParse({ tenants: [] }).success).toBe(false);
    expect(
      consoleTenantsSchema.safeParse({ tenants: [{ id: "Bad!", displayName: "x" }] }).success,
    ).toBe(false);
    expect(schemaForTenant("globex-inc")).toBe("tenant_globex_inc");
    expect(workflowIdFor("run-1")).toBe("run-1");
    expect(workflowIdFor("run-1", "acme")).toBe("acme--run-1");
  });
});

describe("store selection (ticket 038)", () => {
  it("tenanted: a session sees exactly its tenant's runs; unbound/unknown sees NOTHING", async () => {
    const storeA = await seeded("run-a");
    const storeB = await seeded("run-b");
    const deps = {
      tenanted: true,
      untenanted: async (): Promise<EventStore> => {
        throw new Error("untenanted store must not be touched in tenanted mode");
      },
      forTenant: async (id: string) =>
        id === "acme" ? storeA : id === "globex" ? storeB : null,
    };

    const forA = await selectStore(deps, "acme");
    expect((await forA!.listRuns()).map((r) => r.runId)).toEqual(["run-a"]);
    expect(await forA!.load("run-b")).toBeNull(); // B's run does not exist for A

    const forB = await selectStore(deps, "globex");
    expect((await forB!.listRuns()).map((r) => r.runId)).toEqual(["run-b"]);

    expect(await selectStore(deps, undefined)).toBeNull(); // unbound session
    expect(await selectStore(deps, "ghost")).toBeNull(); // unknown tenant — never a default
  });

  it("untenanted: today's shared store, regardless of any tenant claim", async () => {
    const shared = await seeded("run-x");
    const deps = {
      tenanted: false,
      untenanted: async (): Promise<EventStore> => shared,
      forTenant: async (): Promise<EventStore | null> => {
        throw new Error("tenant path must not be touched in untenanted mode");
      },
    };
    expect(await selectStore(deps, undefined)).toBe(shared);
    expect(await selectStore(deps, "acme")).toBe(shared); // no override surface
  });
});

describe("approval gating (ticket 038)", () => {
  const decision = { granted: true, by: "user:approver" };

  it("A's session cannot signal B's runId: not_found and NO signal leaves", async () => {
    const storeA = await seeded("run-a");
    const signals: string[] = [];
    const deps = {
      tenanted: true,
      store: storeA as EventStore | null,
      signal: async (workflowId: string) => {
        signals.push(workflowId);
      },
    };

    expect(await decideApprovalSignal(deps, { runId: "run-b", tenant: "acme", decision })).toBe(
      "not_found",
    );
    expect(signals).toEqual([]); // the no-signal assertion

    expect(await decideApprovalSignal(deps, { runId: "run-a", tenant: "acme", decision })).toBe(
      "signaled",
    );
    expect(signals).toEqual(["acme--run-a"]); // tenant-qualified workflowId (037)
  });

  it("an unbound session in a tenanted deployment can signal nothing", async () => {
    const signals: string[] = [];
    const deps = {
      tenanted: true,
      store: null,
      signal: async (workflowId: string) => {
        signals.push(workflowId);
      },
    };
    expect(
      await decideApprovalSignal(deps, { runId: "run-a", tenant: undefined, decision }),
    ).toBe("not_found");
    expect(signals).toEqual([]);
  });

  it("untenanted keeps the pre-038 path byte-identical: bare runId, no gate", async () => {
    const signals: string[] = [];
    const deps = {
      tenanted: false,
      store: null,
      signal: async (workflowId: string) => {
        signals.push(workflowId);
      },
    };
    expect(
      await decideApprovalSignal(deps, { runId: "run-x", tenant: undefined, decision }),
    ).toBe("signaled");
    expect(signals).toEqual(["run-x"]);
  });
});

describe("delegation gating + mayDecide (ticket 050)", () => {
  it("gateTenantRunSignal: A's session cannot delegate B's runId — not_found, NO signal", async () => {
    const { gateTenantRunSignal } = await import("../src/lib/tenancy");
    const storeA = await seeded("run-a");
    const signals: string[] = [];
    const deps = {
      tenanted: true,
      store: storeA as import("@platform/storage").EventStore | null,
      signal: async (workflowId: string) => {
        signals.push(workflowId);
      },
    };
    expect(await gateTenantRunSignal(deps, { runId: "run-b", tenant: "acme" })).toBe("not_found");
    expect(signals).toEqual([]); // the no-signal pin
    expect(await gateTenantRunSignal(deps, { runId: "run-a", tenant: "acme" })).toBe("signaled");
    expect(signals).toEqual(["acme--run-a"]);
  });

  it("mayDecide: approvers yes; the named delegate yes on THEIR run only; viewers no", async () => {
    const { mayDecide } = await import("../src/lib/delegation");
    const approver = { roles: ["approver" as const], principal: "user:appr" };
    const delegate = { roles: ["viewer" as const], principal: "user:omar" };
    expect(mayDecide(approver, undefined)).toBe(true);
    expect(mayDecide(approver, "user:someone-else")).toBe(true);
    expect(mayDecide(delegate, "user:omar")).toBe(true); // exactly their run
    expect(mayDecide(delegate, "user:other")).toBe(false);
    expect(mayDecide(delegate, undefined)).toBe(false);
  });

  it("delegatedToFromStore computes from the log alone", async () => {
    const { delegatedToFromStore } = await import("../src/lib/delegation");
    const { InMemoryEventStore } = await import("@platform/storage");
    const store = new InMemoryEventStore();
    const base = (seq: number, at: number) => ({ runId: "run-d", seq, at });
    await store.append("run-d", 0, [
      { type: "RunStarted", ...base(0, 1), agent: "a@v1", principal: "u", input: {} },
      { type: "ModelCalled", ...base(1, 2), gatewayReqId: "g", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 },
      { type: "ToolIntentEmitted", ...base(2, 3), tool: "t.write", args: {}, risk: "write" },
      { type: "PolicyEvaluated", ...base(3, 4), decision: "require_approval", rule: "r" },
      { type: "ApprovalRequested", ...base(4, 5), approverGroup: "approvers", expiresAt: 9e12 },
      { type: "ApprovalDelegated", ...base(5, 6), toPrincipal: "user:omar", by: "user:lead" },
    ] as never);
    expect(await delegatedToFromStore(store, "run-d")).toBe("user:omar");
    expect(await delegatedToFromStore(store, "ghost")).toBeUndefined();
    expect(await delegatedToFromStore(null, "run-d")).toBeUndefined();
  });
});
