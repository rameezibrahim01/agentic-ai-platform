import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export interface AppliedMigration {
  name: string;
  applied: boolean;
}

/**
 * Forward-only migrations (architecture §10: release artifacts ship
 * forward-only migrations; there are no down migrations). Numbered .sql files
 * apply in name order; each application is recorded in schema_migrations, so
 * running migrate twice is a no-op.
 */
export async function migrate(pool: Pool): Promise<AppliedMigration[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const results: AppliedMigration[] = [];
  for (const name of files) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // serialize concurrent migrators
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('schema_migrations', 42))");
      const { rows } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (rows.length > 0) {
        await client.query("COMMIT");
        results.push({ name, applied: false });
        continue;
      }
      const sql = await readFile(`${MIGRATIONS_DIR}/${name}`, "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      results.push({ name, applied: true });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return results;
}
