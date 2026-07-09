import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mintDelegation } from "@platform/identity";
import { DEFAULT_RULES } from "@platform/policy";
import { ToolRegistry } from "@platform/tool-registry";
import { createToolGateway } from "@platform/tool-gateway";

const SECRET = "gw-delegation-secret";
const AGENT = "support-triage@v1";
const NOW = 1_700_000_000_000;

function makeGateway(required = true) {
  const registry = new ToolRegistry();
  registry.register({
    name: "crm.lookup",
    version: "v1",
    description: "read tool",
    risk: "read",
    input: z.record(z.unknown()),
    output: z.unknown(),
    egress: [],
  });
  const execute = vi.fn(async () => ({ ok: true }));
  const gateway = createToolGateway({
    registry,
    grants: [{ agent: AGENT, tools: [{ name: "crm.lookup", version: "v1" }] }],
    rules: DEFAULT_RULES,
    executors: [{ ref: { name: "crm.lookup", version: "v1" }, execute }],
    egressAllowlist: [],
    ...(required ? { delegation: { required: true, secret: SECRET } } : {}),
    env: "prod",
    nowMs: () => NOW,
  });
  return { gateway, execute };
}

const delegationFor = (overrides: Partial<Parameters<typeof mintDelegation>[0]> = {}) =>
  mintDelegation(
    {
      principal: "user:jane",
      agent: AGENT,
      env: "prod",
      tools: [{ name: "crm.lookup", version: "v1" }],
      risks: ["read"],
      ...overrides,
    },
    60_000,
    SECRET,
    NOW,
  );

const request = (delegation?: string) => ({
  runId: "r1",
  agent: AGENT,
  principal: "user:jane",
  intent: { tool: "crm.lookup", version: "v1", args: { q: "acme" } },
  ...(delegation !== undefined ? { delegation } : {}),
});

describe("gateway delegation enforcement (ticket 019)", () => {
  it("a valid covering delegation proceeds through the unchanged pipeline", async () => {
    const { gateway, execute } = makeGateway();
    const outcome = await gateway.handleIntent(request(delegationFor()));
    expect(outcome.kind).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("missing delegation is refused before anything executes, audited", async () => {
    const { gateway, execute } = makeGateway();
    const outcome = await gateway.handleIntent(request());
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.reason).toEqual({ code: "delegation_missing", ref: "crm.lookup@v1" });
      expect(outcome.audit.policy).toEqual({ decision: "deny", rule: "gateway:delegation_missing" });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("expired and tampered delegations are typed, audited refusals", async () => {
    const { gateway, execute } = makeGateway();
    const expired = mintDelegation(
      { principal: "user:jane", agent: AGENT, env: "prod", tools: [{ name: "crm.lookup", version: "v1" }], risks: ["read"] },
      1_000,
      SECRET,
      NOW - 10_000, // expired long before NOW
    );
    const expiredOutcome = await gateway.handleIntent(request(expired));
    expect(expiredOutcome.kind).toBe("refused");
    if (expiredOutcome.kind === "refused") {
      expect(expiredOutcome.reason).toEqual({ code: "delegation_invalid", reason: "expired" });
    }

    const tampered = `${delegationFor().slice(0, -4)}XXXX`;
    const tamperedOutcome = await gateway.handleIntent(request(tampered));
    expect(tamperedOutcome.kind).toBe("refused");
    if (tamperedOutcome.kind === "refused") {
      expect(tamperedOutcome.reason.code).toBe("delegation_invalid");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("out-of-scope: wrong tool, insufficient risk, or foreign principal never executes", async () => {
    const { gateway, execute } = makeGateway();

    const wrongTool = delegationFor({ tools: [{ name: "other.tool", version: "v1" }] });
    const wrongToolOutcome = await gateway.handleIntent(request(wrongTool));
    expect(wrongToolOutcome.kind).toBe("refused");
    if (wrongToolOutcome.kind === "refused") {
      expect(wrongToolOutcome.reason.code).toBe("delegation_out_of_scope");
    }

    // a delegation for someone else, presented with jane's principal
    const foreign = delegationFor({ principal: "user:mallory" });
    const foreignOutcome = await gateway.handleIntent(request(foreign));
    expect(foreignOutcome.kind).toBe("refused");
    if (foreignOutcome.kind === "refused") {
      expect(foreignOutcome.reason).toEqual({
        code: "delegation_out_of_scope",
        detail: "principal/agent/env mismatch",
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("unknown tools rate the worst tier: a read-only delegation can never reach them", async () => {
    const { gateway } = makeGateway();
    const outcome = await gateway.handleIntent({
      ...request(delegationFor({ tools: [{ name: "ghost.tool", version: "v9" }] })),
      intent: { tool: "ghost.tool", version: "v9", args: {} },
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      // risk fallback "irreversible" is outside the ["read"] ceiling
      expect(outcome.reason.code).toBe("delegation_out_of_scope");
      expect(outcome.audit.intent?.risk).toBe("irreversible");
    }
  });

  it("without delegation.required the gateway behaves exactly as before", async () => {
    const { gateway, execute } = makeGateway(false);
    const outcome = await gateway.handleIntent(request());
    expect(outcome.kind).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
