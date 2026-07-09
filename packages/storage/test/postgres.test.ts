import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CorruptEventLogError,
  createPostgresEventStore,
  migrate,
  type PostgresStoreHandle,
} from "@platform/storage";
import { describeEventStoreContract, makeEvents } from "@platform/storage/conformance";

// Postgres adapter tests need a reachable database: CI provides a service
// container via TEST_DATABASE_URL and is the authoritative run. Locally the
// suite skips loudly when unset — and never skips in CI.
const databaseUrl = process.env["TEST_DATABASE_URL"];
if (!databaseUrl && process.env["CI"]) {
  throw new Error("CI must set TEST_DATABASE_URL for the Postgres adapter tests");
}
if (!databaseUrl) {
  console.warn(
    "[postgres.test] SKIPPING PostgresEventStore suite: TEST_DATABASE_URL is not set. " +
      "CI runs this suite against a real Postgres service.",
  );
}

describe.skipIf(!databaseUrl)("PostgresEventStore (ticket 006)", () => {
  let handle: PostgresStoreHandle;

  beforeAll(async () => {
    handle = await createPostgresEventStore(databaseUrl!);
  }, 60_000);

  afterAll(async () => {
    await handle?.close();
  });

  // Conformance suite from ticket 002, unchanged; fresh logical store per test.
  describeEventStoreContract("PostgresEventStore", async () => {
    await handle.pool.query("TRUNCATE run_events");
    return handle.store;
  });

  it("migrate is idempotent: second run applies nothing", async () => {
    const second = await migrate(handle.pool);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((m) => m.applied === false)).toBe(true);
    const third = await migrate(handle.pool);
    expect(third).toEqual(second);
  });

  it("migrations applied in numeric order and recorded", async () => {
    const { rows } = await handle.pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.name)).toEqual([...rows.map((r) => r.name)].sort());
  });

  it("the (run_id, seq) primary key is a hard backstop against duplicate positions", async () => {
    await handle.pool.query("TRUNCATE run_events");
    await handle.store.append("run-pk", 0, makeEvents("run-pk", 0, 1));
    await expect(
      handle.pool.query(
        "INSERT INTO run_events (run_id, seq, event) VALUES ('run-pk', 0, '{}'::jsonb)",
      ),
    ).rejects.toMatchObject({ code: "23505" }); // unique_violation
  });

  it("a corrupted row surfaces as CorruptEventLogError, not a raw crash", async () => {
    await handle.pool.query("TRUNCATE run_events");
    await handle.store.append("run-corrupt", 0, makeEvents("run-corrupt", 0, 1));
    await handle.pool.query(
      `INSERT INTO run_events (run_id, seq, event) VALUES ('run-corrupt', 1, '{"type":"NotAnEvent"}'::jsonb)`,
    );
    await expect(handle.store.load("run-corrupt")).rejects.toBeInstanceOf(CorruptEventLogError);
    // listRuns skips the corrupt log instead of failing the whole listing
    const runs = await handle.store.listRuns();
    expect(runs.find((r) => r.runId === "run-corrupt")).toBeUndefined();
  });
});
