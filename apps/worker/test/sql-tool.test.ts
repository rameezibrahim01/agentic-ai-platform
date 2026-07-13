import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  SQL_ROW_CAP,
  sqlQueryExecutorFromPool,
  violatesReadOnlyFloor,
} from "../src/tools/sql.js";
import { buildTools } from "../src/tools-config.js";

// Ticket 045: the governed SQL escape hatch. The floor is structural; the
// wall is the database's own READ ONLY transaction — both pinned here.

describe("the SELECT floor (ticket 045)", () => {
  it("accepts single SELECT/WITH statements, data in strings included", () => {
    expect(violatesReadOnlyFloor("SELECT 1")).toBeNull();
    expect(violatesReadOnlyFloor("  select * from t where a = $1")).toBeNull();
    expect(violatesReadOnlyFloor("WITH x AS (SELECT 1) SELECT * FROM x")).toBeNull();
    expect(violatesReadOnlyFloor("SELECT 'a;b' AS v")).toBeNull(); // ; inside a literal
    expect(violatesReadOnlyFloor("SELECT 'it''s' AS v")).toBeNull(); // escaped quote
    expect(violatesReadOnlyFloor('SELECT ";" FROM "we;ird"')).toBeNull(); // quoted ident
    expect(violatesReadOnlyFloor("SELECT 1 -- trailing; comment")).toBeNull();
    expect(violatesReadOnlyFloor("SELECT 1;")).toBeNull(); // one trailing terminator
  });

  it("refuses multi-statements and non-SELECT verbs, comments stripped first", () => {
    expect(violatesReadOnlyFloor("SELECT 1; DROP TABLE runs")).toMatch(/multiple statements/);
    expect(violatesReadOnlyFloor("INSERT INTO t VALUES (1)")).toMatch(/only SELECT/);
    expect(violatesReadOnlyFloor("UPDATE t SET a = 1")).toMatch(/only SELECT/);
    expect(violatesReadOnlyFloor("DELETE FROM t")).toMatch(/only SELECT/);
    expect(violatesReadOnlyFloor("/* SELECT */ TRUNCATE t")).toMatch(/only SELECT/);
    expect(violatesReadOnlyFloor("-- SELECT\nCREATE TABLE x (a int)")).toMatch(/only SELECT/);
  });
});

describe("sql.query@v1 config (ticket 045)", () => {
  const CONFIG = {
    tools: ["sql.query@v1"],
    grants: [{ agent: "demo-agent@v1", tools: [{ name: "sql.query", version: "v1" }] }],
    egressAllowlist: [],
  };

  it("boot refusals: missing sqlTools section; named-but-empty connection env", async () => {
    expect(await buildTools(CONFIG, {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("sqlTools.connectionEnv"),
    });
    expect(
      await buildTools(
        { ...CONFIG, sqlTools: { connectionEnv: "SQL_TOOL_URL" } },
        { env: {} },
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("named but empty") });
  });

  it("a populated connection env enables the tool from config alone", async () => {
    const built = await buildTools(
      { ...CONFIG, sqlTools: { connectionEnv: "SQL_TOOL_URL" } },
      { env: { SQL_TOOL_URL: "postgres://user:pw@nowhere:5432/db" } },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.tools.registry.describeAll().map((t) => `${t.name}@${t.version}`)).toEqual([
      "sql.query@v1",
    ]);
    expect(built.tools.registry.describe({ name: "sql.query", version: "v1" })).toMatchObject({
      risk: "read",
      egress: [],
    });
  });
});

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl) {
  describe("read-only enforcement against real Postgres (ticket 045, CI-authoritative)", () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    afterAll(() => pool.end());
    const executor = sqlQueryExecutorFromPool(pool);
    const run = (query: string, params?: unknown[]) =>
      executor.execute({ query, ...(params ? { params } : {}) }, {}, {
        runId: "run-sql",
        agent: "demo-agent@v1",
        principal: "user:test",
      } as never);

    it("SELECT round-trips with params", async () => {
      const result = (await run("SELECT $1::int AS a, 'x' AS b", [7])) as {
        rows: unknown[];
        rowCount: number;
        truncated: boolean;
      };
      expect(result).toEqual({ rows: [{ a: 7, b: "x" }], rowCount: 1, truncated: false });
    });

    it("the wall: every write verb dies in the READ ONLY transaction, typed", async () => {
      // shaped to pass the floor (SELECT-prefixed) so the DATABASE refuses them
      const smuggled = [
        "WITH w AS (INSERT INTO run_events (run_id, seq, event) VALUES ('x', 0, '{}') RETURNING 1) SELECT * FROM w",
        "WITH w AS (UPDATE run_events SET event = '{}' RETURNING 1) SELECT * FROM w",
        "WITH w AS (DELETE FROM run_events RETURNING 1) SELECT * FROM w",
        "SELECT * FROM pg_sleep(0) INTO temp_t",
      ];
      for (const query of smuggled) {
        await expect(run(query)).rejects.toThrow(/read-only|cannot execute|syntax/i);
      }
      // and the floor catches the plain verbs before the database sees them
      await expect(run("DROP TABLE run_events")).rejects.toThrow(/only SELECT/);
    });

    it("row cap + truncated flag", async () => {
      const result = (await run(`SELECT generate_series(1, ${SQL_ROW_CAP + 50}) AS n`)) as {
        rows: unknown[];
        rowCount: number;
        truncated: boolean;
      };
      expect(result.rowCount).toBe(SQL_ROW_CAP);
      expect(result.rows).toHaveLength(SQL_ROW_CAP);
      expect(result.truncated).toBe(true);
    });

    it("failures never leak the connection string", async () => {
      const url = new URL(databaseUrl);
      const markers = [databaseUrl, url.password, url.username].filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      for (const query of ["SELECT * FROM table_that_does_not_exist", "DELETE FROM t"]) {
        const error = await run(query).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        for (const marker of markers) {
          expect((error as Error).message).not.toContain(marker);
        }
      }
    });

    it("stays healthy after refusals (transactions always close)", async () => {
      await expect(run("SELECT nope FROM nowhere")).rejects.toThrow();
      const ok = (await run("SELECT 1 AS one")) as { rows: unknown[] };
      expect(ok.rows).toEqual([{ one: 1 }]);
    });
  });

  // verify the pool actually closes? executor pools are per-process; vitest
  // teardown reaps them with the worker process.
} else {
  console.warn(
    "[sql-tool.test] SKIPPING read-only enforcement suite: TEST_DATABASE_URL is not set. CI runs this suite against a real Postgres service.",
  );
}
