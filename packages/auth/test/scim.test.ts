import { describe, expect, it } from "vitest";
import {
  scimPatchActive,
  scimPatchSchema,
  scimToAccount,
  scimUserSchema,
  validateStoredRoles,
} from "@platform/auth";

// Ticket 040: SCIM mapping is pure — IdP groups grant roles/tenant only if
// the config map says so, and a tenanted deployment never guesses.

const MAPPING = {
  roles: {
    rolesClaim: "groups",
    roleMap: { "platform-approvers": ["approver" as const] },
    defaultRoles: ["viewer" as const],
  },
  tenantMap: { "acme-corp": "acme" },
  tenanted: true,
};

const user = (overrides: Record<string, unknown> = {}) =>
  scimUserSchema.parse({
    userName: "Alice@example.com",
    externalId: "idp-sub-1",
    active: true,
    groups: [{ value: "platform-approvers" }, { value: "acme-corp" }],
    ...overrides,
  });

describe("SCIM user schema (ticket 040)", () => {
  it("accepts the IdP's usual shape; defaults active/groups; refuses junk userNames", () => {
    const parsed = scimUserSchema.safeParse({ userName: "bob" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.active).toBe(true);
      expect(parsed.data.groups).toEqual([]);
    }
    expect(scimUserSchema.safeParse({ userName: "" }).success).toBe(false);
    expect(scimUserSchema.safeParse({ userName: "bad name!" }).success).toBe(false);
  });
});

describe("scimToAccount (ticket 040)", () => {
  it("maps groups → roles and tenant from the config alone; username lowercased", () => {
    const result = scimToAccount(user(), MAPPING);
    expect(result).toEqual({
      ok: true,
      account: {
        username: "alice@example.com",
        externalId: "idp-sub-1",
        roles: ["approver"],
        tenant: "acme",
        active: true,
      },
    });
  });

  it("no mapped group → default roles, never admin; inactive rides through", () => {
    const result = scimToAccount(
      user({ groups: [{ value: "strangers" }, { value: "acme-corp" }], active: false }),
      MAPPING,
    );
    expect(result.ok && result.account.roles).toEqual(["viewer"]);
    expect(result.ok && result.account.active).toBe(false);
  });

  it("tenanted + no tenant-mapped group = typed refusal, never a default", () => {
    expect(
      scimToAccount(user({ groups: [{ value: "platform-approvers" }] }), MAPPING),
    ).toEqual({ ok: false, reason: "unmapped_tenant" });
    // untenanted: same user provisions fine, tenantless
    const untenanted = scimToAccount(user({ groups: [{ value: "platform-approvers" }] }), {
      ...MAPPING,
      tenanted: false,
    });
    expect(untenanted.ok).toBe(true);
    if (untenanted.ok) expect(untenanted.account.tenant).toBeUndefined();
  });
});

describe("SCIM patch floor (ticket 040)", () => {
  it("replace(active) works via path and via value object; everything else refused", () => {
    const byPath = scimPatchSchema.parse({
      Operations: [{ op: "Replace", path: "active", value: false }],
    });
    expect(scimPatchActive(byPath)).toEqual({ ok: true, active: false });

    const byValue = scimPatchSchema.parse({
      Operations: [{ op: "replace", value: { active: true } }],
    });
    expect(scimPatchActive(byValue)).toEqual({ ok: true, active: true });

    const wrongOp = scimPatchSchema.parse({
      Operations: [{ op: "add", path: "active", value: true }],
    });
    expect(scimPatchActive(wrongOp).ok).toBe(false);
    const wrongPath = scimPatchSchema.parse({
      Operations: [{ op: "replace", path: "userName", value: "x" }],
    });
    expect(scimPatchActive(wrongPath).ok).toBe(false);
    const wrongType = scimPatchSchema.parse({
      Operations: [{ op: "replace", path: "active", value: "yes" }],
    });
    expect(scimPatchActive(wrongType).ok).toBe(false);
  });
});

describe("stored-role validation at the login boundary (ticket 040)", () => {
  it("valid roles pass; unknown or empty refuse — never a partial grant", () => {
    expect(validateStoredRoles(["approver", "viewer"])).toEqual({
      ok: true,
      roles: ["approver", "viewer"],
    });
    expect(validateStoredRoles(["superuser"]).ok).toBe(false);
    expect(validateStoredRoles([]).ok).toBe(false);
  });
});
