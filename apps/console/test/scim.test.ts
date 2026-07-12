import { describe, expect, it } from "vitest";
import { InMemoryAccountStore } from "@platform/storage";
import {
  checkScimAuth,
  scimCreateUser,
  scimDeleteUser,
  scimGetUser,
  scimListUsers,
  scimPatchUser,
} from "../src/lib/scim";
import type { ScimDeps } from "../src/lib/scim";

// Ticket 040: the endpoints' whole decision surface over an injected store —
// no HTTP, no IdP. The routes are thin adapters over exactly these calls.

const NOW = 1_700_000_000_000;

function makeDeps(tenanted = true): ScimDeps & { store: InMemoryAccountStore } {
  return {
    store: new InMemoryAccountStore(),
    mapping: {
      roles: {
        rolesClaim: "groups",
        roleMap: { "platform-approvers": ["approver"] },
        defaultRoles: ["viewer"],
      },
      tenantMap: { "acme-corp": "acme" },
      tenanted,
    },
    nowMs: () => NOW,
  };
}

const ALICE = {
  userName: "alice",
  externalId: "idp-sub-1",
  active: true,
  groups: [{ value: "platform-approvers" }, { value: "acme-corp" }],
};

describe("SCIM bearer auth (ticket 040)", () => {
  it("constant-time bearer check: right token passes, everything else fails", () => {
    expect(checkScimAuth("Bearer s3cret", "s3cret")).toBe(true);
    expect(checkScimAuth("Bearer wrong", "s3cret")).toBe(false);
    expect(checkScimAuth("Bearer s3cret2", "s3cret")).toBe(false);
    expect(checkScimAuth("Basic s3cret", "s3cret")).toBe(false);
    expect(checkScimAuth(null, "s3cret")).toBe(false);
  });
});

describe("SCIM Users lifecycle (ticket 040)", () => {
  it("create → 201 with mapped roles/tenant; repeat create is an upsert 200", async () => {
    const deps = makeDeps();
    const created = await scimCreateUser(deps, ALICE);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: "alice",
      userName: "alice",
      active: true,
      "urn:platform:roles": ["approver"],
      "urn:platform:tenant": "acme",
    });
    const again = await scimCreateUser(deps, { ...ALICE, groups: [{ value: "acme-corp" }] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ "urn:platform:roles": ["viewer"] }); // re-provision updates
  });

  it("malformed payloads 400; tenanted + unmapped tenant 400; externalId takeover 409", async () => {
    const deps = makeDeps();
    expect((await scimCreateUser(deps, { userName: "" })).status).toBe(400);
    expect(
      (await scimCreateUser(deps, { ...ALICE, groups: [{ value: "platform-approvers" }] }))
        .status,
    ).toBe(400);
    await scimCreateUser(deps, ALICE);
    const takeover = await scimCreateUser(deps, { ...ALICE, userName: "mallory" });
    expect(takeover.status).toBe(409); // one IdP identity, one account
    expect((await scimGetUser(deps, "mallory")).status).toBe(404);
  });

  it("list + userName filter; unsupported filters refused", async () => {
    const deps = makeDeps();
    await scimCreateUser(deps, ALICE);
    await scimCreateUser(deps, {
      ...ALICE,
      userName: "bob",
      externalId: "idp-sub-2",
    });
    const all = await scimListUsers(deps, null);
    expect(all.body).toMatchObject({ totalResults: 2 });
    const filtered = await scimListUsers(deps, 'userName eq "alice"');
    expect(filtered.body).toMatchObject({
      totalResults: 1,
      Resources: [{ id: "alice" }],
    });
    expect((await scimListUsers(deps, "externalId pr")).status).toBe(400);
  });

  it("deactivate via DELETE and PATCH; reactivate via PATCH; the row never deletes", async () => {
    const deps = makeDeps();
    await scimCreateUser(deps, ALICE);

    expect((await scimDeleteUser(deps, "alice")).status).toBe(204);
    expect((await scimGetUser(deps, "alice")).body).toMatchObject({ active: false });

    const reactivated = await scimPatchUser(deps, "alice", {
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ active: true });

    const deactivated = await scimPatchUser(deps, "alice", {
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(deactivated.body).toMatchObject({ active: false });

    expect((await scimPatchUser(deps, "ghost", { Operations: [{ op: "replace", path: "active", value: true }] })).status).toBe(404);
    expect((await scimDeleteUser(deps, "ghost")).status).toBe(404);
    // unsupported patch = 400, state untouched
    const bad = await scimPatchUser(deps, "alice", {
      Operations: [{ op: "replace", path: "userName", value: "eve" }],
    });
    expect(bad.status).toBe(400);
    expect((await scimGetUser(deps, "alice")).body).toMatchObject({ active: false });
  });
});
