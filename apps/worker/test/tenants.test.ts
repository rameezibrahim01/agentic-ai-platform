import pg from "pg";
import { describe, expect, it } from "vitest";
import { CorruptEventLogError } from "@platform/storage";
import { makeEvents } from "@platform/storage/conformance";
import { openTenantStores, parseTenantsConfig, schemaFor } from "../src/tenants.js";

// Ticket 036: tenants are configuration; isolation is proven, not asserted.

const VALID = {
  tenants: [
    { id: "acme", displayName: "Acme Corp", dataKeyEnv: "ACME_DATA_KEY" },
    { id: "globex-inc", displayName: "Globex" },
  ],
};

describe("tenant registry (ticket 036)", () => {
  it("parses valid config; slugs map to schema names deterministically", () => {
    const parsed = parseTenantsConfig(VALID);
    expect(parsed.ok).toBe(true);
    expect(schemaFor("acme")).toBe("tenant_acme");
    expect(schemaFor("globex-inc")).toBe("tenant_globex_inc");
  });

  it("boot refusals: bad slug, duplicate id, extra keys", () => {
    expect(parseTenantsConfig({ tenants: [{ id: "Bad_Slug!", displayName: "x" }] }).ok).toBe(false);
    expect(
      parseTenantsConfig({
        tenants: [
          { id: "acme", displayName: "a" },
          { id: "acme", displayName: "b" },
        ],
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("duplicate") });
    expect(parseTenantsConfig({ tenants: [], extra: 1 }).ok).toBe(false);
    expect(parseTenantsConfig({ tenants: [] }).ok).toBe(false); // min 1
  });
});

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl) {
  describe("schema-per-tenant isolation (ticket 036, CI-authoritative)", () => {
    it("named-but-empty data key envs refuse boot — never silent plaintext", async () => {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      try {
        const parsed = parseTenantsConfig(VALID);
        if (!parsed.ok) throw new Error(parsed.error);
        await expect(openTenantStores(pool, parsed.config, {})).rejects.toThrow(
          /ACME_DATA_KEY is named but empty/,
        );
      } finally {
        await pool.end();
      }
    });

    it("same runId in two tenants: no cross-reads, no cross-deletes, per-tenant keys", async () => {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      try {
        const parsed = parseTenantsConfig(VALID);
        if (!parsed.ok) throw new Error(parsed.error);
        const stores = await openTenantStores(pool, parsed.config, {
          ACME_DATA_KEY: "c".repeat(64),
        });
        const acme = stores.get("acme")!;
        const globex = stores.get("globex-inc")!;
        await pool.query(`TRUNCATE ${acme.schema}.run_events`);
        await pool.query(`TRUNCATE ${globex.schema}.run_events`);

        // the SAME runId in both tenants — two independent runs
        await acme.store.append("run-shared", 0, makeEvents("run-shared", 0, 3));
        await globex.store.append("run-shared", 0, makeEvents("run-shared", 0, 1));
        expect((await acme.store.load("run-shared"))?.version).toBe(3);
        expect((await globex.store.load("run-shared"))?.version).toBe(1);

        // deleting in one leaves the other untouched
        expect(await globex.store.deleteRun("run-shared")).toEqual({ ok: true });
        expect(await globex.store.load("run-shared")).toBeNull();
        expect((await acme.store.load("run-shared"))?.version).toBe(3);

        // acme's rows are ciphertext under ACME's key; globex's plaintext
        // reader (its own schema, no key) cannot see them at all — and a
        // keyless reader on acme's schema gets typed unreadability
        const raw = await pool.query<{ event: unknown }>(
          `SELECT event FROM ${acme.schema}.run_events LIMIT 1`,
        );
        expect(JSON.stringify(raw.rows[0]!.event)).toContain("aes-256-gcm");
        const { PostgresEventStore } = await import("@platform/storage");
        const keyless = new PostgresEventStore(pool, undefined, acme.schema);
        await expect(keyless.load("run-shared")).rejects.toThrow(CorruptEventLogError);

        // listRuns never crosses schemas
        expect((await acme.store.listRuns()).map((r) => r.runId)).toEqual(["run-shared"]);
        expect(await globex.store.listRuns()).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  });
} else {
  console.warn(
    "[tenants.test] SKIPPING schema isolation suite: TEST_DATABASE_URL is not set. CI runs this suite against a real Postgres service.",
  );
}
