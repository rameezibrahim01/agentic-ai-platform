import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryAccountStore, migrate, PostgresAccountStore } from "@platform/storage";
import type { AccountRecord, AccountStore } from "@platform/storage";

// Ticket 040: the SCIM account store. Both adapters obey the same contract —
// upsert-by-username, one IdP identity per account, deactivation flips a bit
// and never deletes.

const ALICE: AccountRecord = {
  username: "alice",
  externalId: "idp-sub-alice",
  roles: ["approver"],
  tenant: "acme",
  active: true,
  updatedAt: 1_700_000_000_000,
};

function accountStoreContract(name: string, make: () => Promise<AccountStore>) {
  describe(`AccountStore contract: ${name}`, () => {
    it("upsert round-trips; update replaces; lookups by username and externalId agree", async () => {
      const store = await make();
      expect(await store.upsert(ALICE)).toEqual({ ok: true });
      expect(await store.get("alice")).toEqual(ALICE);
      expect(await store.getByExternalId("idp-sub-alice")).toEqual(ALICE);
      expect(await store.get("ghost")).toBeUndefined();
      expect(await store.getByExternalId("ghost")).toBeUndefined();

      const updated = { ...ALICE, roles: ["viewer"], updatedAt: 1_700_000_001_000 };
      expect(await store.upsert(updated)).toEqual({ ok: true });
      expect(await store.get("alice")).toEqual(updated);
      expect(await store.list()).toEqual([updated]);
    });

    it("one IdP identity, one account: a second username with the same externalId refuses", async () => {
      const store = await make();
      await store.upsert(ALICE);
      const impostor = { ...ALICE, username: "alice2" };
      expect(await store.upsert(impostor)).toEqual({ ok: false, error: "external_id_conflict" });
      expect(await store.get("alice2")).toBeUndefined();
    });

    it("deactivate flips the bit, keeps the row, is typed on a miss", async () => {
      const store = await make();
      await store.upsert(ALICE);
      expect(await store.deactivate("alice", 1_700_000_002_000)).toEqual({ ok: true });
      const record = await store.get("alice");
      expect(record).toMatchObject({ active: false, updatedAt: 1_700_000_002_000 });
      // reactivation is an upsert — the same record, active again
      expect(await store.upsert({ ...record!, active: true })).toEqual({ ok: true });
      expect((await store.get("alice"))!.active).toBe(true);
      expect(await store.deactivate("ghost", 1)).toEqual({ ok: false, error: "not_found" });
    });

    it("optional fields stay optional: no externalId, no tenant", async () => {
      const store = await make();
      const bare: AccountRecord = {
        username: "bob",
        roles: ["viewer"],
        active: true,
        updatedAt: 1,
      };
      expect(await store.upsert(bare)).toEqual({ ok: true });
      expect(await store.get("bob")).toEqual(bare);
    });
  });
}

accountStoreContract("InMemoryAccountStore", async () => new InMemoryAccountStore());

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl) {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await migrate(pool); // applies 004-accounts.sql alongside the rest
  });
  afterAll(async () => {
    await pool.end();
  });
  accountStoreContract("PostgresAccountStore", async () => {
    await pool.query("TRUNCATE accounts");
    return new PostgresAccountStore(pool);
  });
} else {
  console.warn(
    "[accounts.test] SKIPPING PostgresAccountStore suite: TEST_DATABASE_URL is not set. CI runs this suite against a real Postgres service.",
  );
}
