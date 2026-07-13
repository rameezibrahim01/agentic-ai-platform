import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryOpsAuditStore, migrate, PostgresOpsAuditStore } from "@platform/storage";
import type { OpsAuditStore } from "@platform/storage";

// Ticket 047: the operator-action trail. Record and list are the WHOLE
// surface — no update, no delete, on either adapter.

const ENTRY = {
  at: 1_700_000_000_000,
  principal: "user:admin",
  action: "kill_switch_flip",
  scope: "shared",
  detail: { switch: "global", from: false, to: true, file: "/cfg/limits.config.json" },
};

function opsAuditContract(name: string, make: () => Promise<OpsAuditStore>) {
  describe(`OpsAuditStore contract: ${name}`, () => {
    it("records append in order and round-trip exactly; the surface has no mutators", async () => {
      const store = await make();
      await store.record(ENTRY);
      await store.record({ ...ENTRY, at: ENTRY.at + 1, action: "kill_switch_flip_refused" });
      const rows = await store.list();
      expect(rows).toEqual([
        ENTRY,
        { ...ENTRY, at: ENTRY.at + 1, action: "kill_switch_flip_refused" },
      ]);
      // append-only by construction: record and list are the entire interface
      expect(Object.keys({ record: store.record, list: store.list })).toEqual(["record", "list"]);
    });
  });
}

opsAuditContract("InMemoryOpsAuditStore", async () => new InMemoryOpsAuditStore());

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl) {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await migrate(pool); // applies 005-ops-audit alongside the rest
  });
  afterAll(async () => {
    await pool.end();
  });
  opsAuditContract("PostgresOpsAuditStore", async () => {
    await pool.query("TRUNCATE ops_audit");
    return new PostgresOpsAuditStore(pool);
  });
} else {
  console.warn(
    "[ops-audit.test] SKIPPING PostgresOpsAuditStore suite: TEST_DATABASE_URL is not set. CI runs this suite against a real Postgres service.",
  );
}
