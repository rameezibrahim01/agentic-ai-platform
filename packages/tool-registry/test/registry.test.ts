import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hasGrant,
  refKey,
  ToolRegistry,
  type AgentGrants,
  type ToolContract,
} from "@platform/tool-registry";

function lookupContract(version = "v1"): ToolContract {
  return {
    name: "crm.lookup",
    version,
    description: "Look up a CRM record",
    risk: "read",
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100) }).strict(),
    output: z.object({ records: z.array(z.object({ id: z.number().int() })) }).strict(),
    egress: ["crm.internal.example"],
  };
}

describe("ToolRegistry (ticket 014)", () => {
  it("versions are immutable: duplicate name@version is a typed refusal, original untouched", () => {
    const registry = new ToolRegistry();
    expect(registry.register(lookupContract())).toEqual({ ok: true, ref: "crm.lookup@v1" });

    const usurper = { ...lookupContract(), description: "impostor", risk: "financial" as const };
    expect(registry.register(usurper)).toEqual({
      ok: false,
      error: { code: "already_registered", ref: "crm.lookup@v1" },
    });
    expect(registry.describe({ name: "crm.lookup", version: "v1" })).toMatchObject({
      description: "Look up a CRM record",
      risk: "read",
    });
  });

  it("different versions of the same tool coexist", () => {
    const registry = new ToolRegistry();
    expect(registry.register(lookupContract("v1")).ok).toBe(true);
    expect(registry.register({ ...lookupContract("v2"), risk: "write" }).ok).toBe(true);
    expect(registry.describe({ name: "crm.lookup", version: "v1" })?.risk).toBe("read");
    expect(registry.describe({ name: "crm.lookup", version: "v2" })?.risk).toBe("write");
  });

  it("unknown tools are typed not-found for get and both validations", () => {
    const registry = new ToolRegistry();
    const ref = { name: "ghost", version: "v9" };
    expect(registry.get(ref)).toEqual({ ok: false, error: { code: "tool_not_found", ref: "ghost@v9" } });
    expect(registry.validateInput(ref, {})).toEqual({
      ok: false,
      error: { code: "tool_not_found", ref: "ghost@v9" },
    });
    expect(registry.validateOutput(ref, {})).toMatchObject({ ok: false });
  });

  it("property: validateInput accepts exactly what the schema accepts", () => {
    const registry = new ToolRegistry();
    registry.register(lookupContract());
    const ref = { name: "crm.lookup", version: "v1" };

    fc.assert(
      fc.property(
        fc.record({
          query: fc.string({ maxLength: 20 }),
          limit: fc.integer({ min: -10, max: 200 }),
        }),
        ({ query, limit }) => {
          const schemaAccepts = query.length >= 1 && limit >= 1 && limit <= 100;
          const result = registry.validateInput(ref, { query, limit });
          expect(result.ok).toBe(schemaAccepts);
          if (!result.ok && "issues" in result.error) {
            expect(result.error.issues.length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it("property: validateOutput labels malformed results with issues", () => {
    const registry = new ToolRegistry();
    registry.register(lookupContract());
    const ref = { name: "crm.lookup", version: "v1" };

    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ records: fc.array(fc.record({ id: fc.integer() })) }), // valid
          fc.record({ records: fc.array(fc.record({ id: fc.string() })) }), // wrong type
          fc.constant({ wrong: true }),
          fc.constant(null),
        ),
        (value) => {
          const result = registry.validateOutput(ref, value);
          const valid =
            value !== null &&
            typeof value === "object" &&
            "records" in value &&
            Array.isArray((value as { records: unknown[] }).records) &&
            (value as { records: { id: unknown }[] }).records.every(
              (r) => typeof r.id === "number" && Number.isInteger(r.id),
            );
          expect(result.ok).toBe(valid);
        },
      ),
    );
  });

  it("input validation rejects extra keys (strict contracts)", () => {
    const registry = new ToolRegistry();
    registry.register(lookupContract());
    const result = registry.validateInput(
      { name: "crm.lookup", version: "v1" },
      { query: "acme", limit: 10, exfiltrate: "yes-please" },
    );
    expect(result.ok).toBe(false);
  });

  it("describe() is JSON-serializable and carries no schema internals", () => {
    const registry = new ToolRegistry();
    registry.register(lookupContract());
    const description = registry.describe({ name: "crm.lookup", version: "v1" })!;
    const roundTripped: unknown = JSON.parse(JSON.stringify(description));
    expect(roundTripped).toEqual(description);
    expect(Object.keys(description).sort()).toEqual([
      "description",
      "egress",
      "name",
      "risk",
      "version",
    ]);
    expect(registry.describeAll()).toEqual([description]);
  });
});

describe("grants (exact name@version)", () => {
  const grants: AgentGrants[] = [
    { agent: "support-triage@v1", tools: [{ name: "crm.lookup", version: "v1" }] },
  ];

  it("granted tool passes; same name different version is refused", () => {
    expect(hasGrant(grants, "support-triage@v1", { name: "crm.lookup", version: "v1" })).toBe(true);
    expect(hasGrant(grants, "support-triage@v1", { name: "crm.lookup", version: "v2" })).toBe(false);
  });

  it("other agents and other tools are refused", () => {
    expect(hasGrant(grants, "other-agent@v1", { name: "crm.lookup", version: "v1" })).toBe(false);
    expect(hasGrant(grants, "support-triage@v1", { name: "payments.refund", version: "v1" })).toBe(false);
    expect(hasGrant([], "support-triage@v1", { name: "crm.lookup", version: "v1" })).toBe(false);
  });

  it("refKey is the exact identity", () => {
    expect(refKey({ name: "a", version: "v1" })).toBe("a@v1");
  });
});
