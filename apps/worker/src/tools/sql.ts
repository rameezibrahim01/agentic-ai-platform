import pg from "pg";
import { z } from "zod";
import type { ToolContract } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";

// The scoped read-only SQL tool (ticket 045) — architecture §6's escape
// hatch, governed. Enforcement is layered: a single-statement SELECT floor
// here, and the REAL wall in the database — every query runs inside a
// READ ONLY transaction with a server-side statement timeout, so a smuggled
// write is a typed Postgres failure, never a regex race. The connection
// string comes from a NAMED env var in config (CLAUDE.md #4) and appears in
// no event, log, or error.

export const SQL_ROW_CAP = 200;
export const SQL_STATEMENT_TIMEOUT_MS = 5_000;

export const sqlQueryContract: ToolContract = {
  name: "sql.query",
  version: "v1",
  description: "Read-only SQL query (SELECT only) against the configured database.",
  risk: "read",
  input: z
    .object({
      query: z.string().min(1).max(10_000),
      params: z.array(z.unknown()).max(20).optional(),
    })
    .strict(),
  output: z
    .object({
      rows: z.array(z.record(z.unknown())),
      rowCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
  egress: [],
};

/** Strip string literals, quoted identifiers, and comments so the floor
 * checks look at STRUCTURE, never data. */
function stripQuoted(query: string): string {
  let out = "";
  let i = 0;
  while (i < query.length) {
    const ch = query[i]!;
    if (ch === "'") {
      i += 1;
      while (i < query.length) {
        if (query[i] === "'" && query[i + 1] === "'") i += 2; // escaped ''
        else if (query[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
    } else if (ch === '"') {
      i += 1;
      while (i < query.length && query[i] !== '"') i += 1;
      i += 1;
    } else if (ch === "-" && query[i + 1] === "-") {
      while (i < query.length && query[i] !== "\n") i += 1;
    } else if (ch === "/" && query[i + 1] === "*") {
      i += 2;
      while (i < query.length && !(query[i] === "*" && query[i + 1] === "/")) i += 1;
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The floor: one statement, SELECT-shaped. Returns the refusal reason or null. */
export function violatesReadOnlyFloor(query: string): string | null {
  const stripped = stripQuoted(query);
  if (stripped.replace(/;\s*$/, "").includes(";")) {
    return "multiple statements are not allowed";
  }
  const head = stripped.trimStart().slice(0, 6).toUpperCase();
  if (!head.startsWith("SELECT") && !head.startsWith("WITH")) {
    return "only SELECT (or WITH … SELECT) statements are allowed";
  }
  return null;
}

export function sqlQueryExecutor(connectionString: string): ToolExecutor {
  // small dedicated pool; the connection string lives ONLY in this closure
  return sqlQueryExecutorFromPool(new pg.Pool({ connectionString, max: 2 }));
}

/** Pool-injected variant (tests own the pool's lifecycle). */
export function sqlQueryExecutorFromPool(pool: pg.Pool): ToolExecutor {
  return {
    ref: { name: sqlQueryContract.name, version: sqlQueryContract.version },
    async execute(args) {
      const { query, params } = args as { query: string; params?: unknown[] };
      const floor = violatesReadOnlyFloor(query);
      if (floor !== null) throw new Error(`sql.query refused: ${floor}`);
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query(`SET LOCAL statement_timeout = ${SQL_STATEMENT_TIMEOUT_MS}`);
        const result = await client.query(query, (params as unknown[] | undefined) ?? []);
        await client.query("COMMIT");
        const rows = (result.rows ?? []) as Record<string, unknown>[];
        const truncated = rows.length > SQL_ROW_CAP;
        return {
          rows: truncated ? rows.slice(0, SQL_ROW_CAP) : rows,
          rowCount: truncated ? SQL_ROW_CAP : rows.length,
          truncated,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        // pg error messages never carry the connection string; neither do ours
        throw new Error(
          `sql.query failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        client.release();
      }
    },
  };
}
