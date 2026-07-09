import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_RULE_ID,
  DEFAULT_RULES,
  evaluatePolicy,
  type PolicyContext,
  type PolicyRule,
} from "@platform/policy";

const RISKS = ["read", "write", "irreversible", "financial"] as const;
const DECISIONS = ["allow", "deny", "require_approval"] as const;

const contextArb: fc.Arbitrary<PolicyContext> = fc.record({
  agent: fc.string({ minLength: 1, maxLength: 12 }),
  principal: fc.string({ minLength: 1, maxLength: 12 }),
  tool: fc.record({
    name: fc.string({ minLength: 1, maxLength: 12 }),
    version: fc.constantFrom("v1", "v2"),
    risk: fc.constantFrom(...RISKS),
  }),
  env: fc.constantFrom("dev", "staging", "prod"),
});

const ruleArb: fc.Arbitrary<PolicyRule> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  description: fc.constant("generated"),
  match: fc.record(
    {
      env: fc.constantFrom("dev", "staging", "prod"),
      agent: fc.string({ minLength: 1, maxLength: 12 }),
      tool: fc.string({ minLength: 1, maxLength: 12 }),
      risk: fc.uniqueArray(fc.constantFrom(...RISKS), { minLength: 1, maxLength: 4 }),
    },
    { requiredKeys: [] },
  ),
  decision: fc.constantFrom(...DECISIONS),
});

describe("evaluatePolicy (ticket 015)", () => {
  it("property: total and deterministic over arbitrary contexts and rule sets", () => {
    fc.assert(
      fc.property(contextArb, fc.array(ruleArb, { maxLength: 12 }), (context, rules) => {
        const frozenContext = Object.freeze(structuredClone(context));
        const frozenRules = Object.freeze(structuredClone(rules));
        const first = evaluatePolicy(frozenContext, frozenRules as PolicyRule[]);
        const second = evaluatePolicy(frozenContext, frozenRules as PolicyRule[]);
        expect(second).toEqual(first);
        expect(DECISIONS).toContain(first.decision);
        expect(first.ruleId.length).toBeGreaterThan(0);
        expect(frozenContext).toEqual(context);
      }),
    );
  });

  it("property: under DEFAULT_RULES, irreversible/financial NEVER evaluate to plain allow", () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        fc.pre(context.tool.risk === "irreversible" || context.tool.risk === "financial");
        const result = evaluatePolicy(context, DEFAULT_RULES);
        expect(result.decision).toBe("require_approval");
        expect(result.ruleId).toBe("irreversible-financial-always-approve");
      }),
    );
  });

  it("environment split: the identical write intent allows in dev, requires approval in prod", () => {
    const base: PolicyContext = {
      agent: "support-triage@v1",
      principal: "user:jane",
      tool: { name: "zendesk.update_ticket", version: "v3", risk: "write" },
      env: "dev",
    };
    expect(evaluatePolicy(base, DEFAULT_RULES)).toEqual({
      decision: "allow",
      ruleId: "write-dev-auto-allow",
    });
    expect(evaluatePolicy({ ...base, env: "prod" }, DEFAULT_RULES)).toEqual({
      decision: "require_approval",
      ruleId: "write-requires-approval",
    });
  });

  it("reads auto-allow everywhere under DEFAULT_RULES", () => {
    for (const env of ["dev", "staging", "prod"]) {
      const result = evaluatePolicy(
        {
          agent: "a",
          principal: "u",
          tool: { name: "crm.lookup", version: "v1", risk: "read" },
          env,
        },
        DEFAULT_RULES,
      );
      expect(result).toEqual({ decision: "allow", ruleId: "read-auto-allow" });
    }
  });

  it("first match wins: a specific deny before a general allow; reordering flips it", () => {
    const denyFirst: PolicyRule[] = [
      { id: "deny-payments", description: "", match: { tool: "payments.refund" }, decision: "deny" },
      { id: "allow-all-reads", description: "", match: { risk: ["read"] }, decision: "allow" },
    ];
    const context: PolicyContext = {
      agent: "a",
      principal: "u",
      tool: { name: "payments.refund", version: "v1", risk: "read" },
      env: "prod",
    };
    expect(evaluatePolicy(context, denyFirst).ruleId).toBe("deny-payments");
    expect(evaluatePolicy(context, [...denyFirst].reverse()).ruleId).toBe("allow-all-reads");
  });

  it("no match → default-deny; empty rules deny everything", () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        expect(evaluatePolicy(context, [])).toEqual({
          decision: "deny",
          ruleId: DEFAULT_DENY_RULE_ID,
        });
      }),
    );
  });

  it("DEFAULT_RULES stays under ten rules (premature generality is how policy engines die)", () => {
    expect(DEFAULT_RULES.length).toBeLessThan(10);
  });
});
