import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  delegationCovers,
  mintDelegation,
  verifyDelegation,
  workloadIdentityFor,
  type DelegationScope,
} from "@platform/identity";

const SECRET = "test-delegation-secret";
const RISKS = ["read", "write", "irreversible", "financial"] as const;

const scopeArb: fc.Arbitrary<DelegationScope> = fc.record({
  principal: fc.stringMatching(/^user:[a-z]{1,10}$/),
  agent: fc.stringMatching(/^[a-z-]{1,12}@v[0-9]$/),
  env: fc.constantFrom("dev", "staging", "prod"),
  tools: fc.uniqueArray(
    fc.record({
      name: fc.stringMatching(/^[a-z.]{1,10}$/),
      version: fc.constantFrom("v1", "v2"),
    }),
    { minLength: 1, maxLength: 3, selector: (t) => `${t.name}@${t.version}` },
  ),
  risks: fc.uniqueArray(fc.constantFrom(...RISKS), { minLength: 1, maxLength: 4 }),
});

describe("delegation tokens (ticket 019)", () => {
  it("workload identity is distinct per agent per environment", () => {
    expect(workloadIdentityFor("triage@v1", "prod")).toBe("platform://agent/triage@v1/prod");
    expect(workloadIdentityFor("triage@v1", "dev")).not.toBe(workloadIdentityFor("triage@v1", "prod"));
    expect(workloadIdentityFor("other@v1", "prod")).not.toBe(workloadIdentityFor("triage@v1", "prod"));
  });

  it("property: round-trip carries the exact scope, time-boxed", () => {
    fc.assert(
      fc.property(
        scopeArb,
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 2 ** 44 }),
        (scope, ttlMs, nowMs) => {
          const token = mintDelegation(scope, ttlMs, SECRET, nowMs);
          const verified = verifyDelegation(token, SECRET, nowMs);
          expect(verified.ok).toBe(true);
          if (verified.ok) {
            expect(verified.claims).toEqual({
              principal: scope.principal,
              agent: scope.agent,
              env: scope.env,
              presenter: workloadIdentityFor(scope.agent, scope.env),
              tools: scope.tools,
              risks: scope.risks,
              exp: nowMs + ttlMs,
            });
          }
        },
      ),
    );
  });

  it("expires exactly at ttl; a foreign-secret token is tampered", () => {
    const scope: DelegationScope = {
      principal: "user:jane",
      agent: "triage@v1",
      env: "prod",
      tools: [{ name: "crm.lookup", version: "v1" }],
      risks: ["read"],
    };
    const token = mintDelegation(scope, 1_000, SECRET, 50_000);
    expect(verifyDelegation(token, SECRET, 50_999).ok).toBe(true);
    expect(verifyDelegation(token, SECRET, 51_000)).toEqual({ ok: false, reason: "expired" });
    const foreign = mintDelegation(scope, 1_000, "other-secret", 50_000);
    expect(verifyDelegation(foreign, SECRET, 50_000)).toEqual({ ok: false, reason: "tampered" });
    expect(verifyDelegation("garbage", SECRET, 0)).toEqual({ ok: false, reason: "malformed" });
  });

  it("property: any single-character tamper is rejected", () => {
    const scope: DelegationScope = {
      principal: "user:jane",
      agent: "triage@v1",
      env: "prod",
      tools: [{ name: "crm.lookup", version: "v1" }],
      risks: ["read"],
    };
    const token = mintDelegation(scope, 60_000, SECRET, 1_000);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: token.length - 1 }),
        fc.constantFrom(..."ABCXYZ0189_-"),
        (index, replacement) => {
          fc.pre(token[index] !== replacement);
          const tampered = token.slice(0, index) + replacement + token.slice(index + 1);
          expect(verifyDelegation(tampered, SECRET, 1_000).ok).toBe(false);
        },
      ),
    );
  });

  it("coverage: exact name@version AND risk within the ceiling — nothing broader", () => {
    const scope: DelegationScope = {
      principal: "user:jane",
      agent: "triage@v1",
      env: "prod",
      tools: [{ name: "crm.lookup", version: "v1" }],
      risks: ["read"],
    };
    const token = mintDelegation(scope, 60_000, SECRET, 0);
    const verified = verifyDelegation(token, SECRET, 0);
    if (!verified.ok) throw new Error("fixture invalid");
    const { claims } = verified;

    expect(delegationCovers(claims, { name: "crm.lookup", version: "v1" }, "read")).toBe(true);
    // never another version, another tool, or a higher risk:
    expect(delegationCovers(claims, { name: "crm.lookup", version: "v2" }, "read")).toBe(false);
    expect(delegationCovers(claims, { name: "payments.refund", version: "v1" }, "read")).toBe(false);
    expect(delegationCovers(claims, { name: "crm.lookup", version: "v1" }, "write")).toBe(false);
    expect(delegationCovers(claims, { name: "crm.lookup", version: "v1" }, "irreversible")).toBe(false);
  });
});
