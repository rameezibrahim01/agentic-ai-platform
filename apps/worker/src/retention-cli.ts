import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  applyRetention,
  migrate,
  PostgresEventStore,
  PostgresHoldStore,
} from "@platform/storage";

// Retention CLI (ticket 032). DRY-RUN by default — deletion demands an
// explicit --yes. Recommended flow: export first (audit-export-cli, 031);
// what retention deletes should already live, chained, in the SIEM.
//   tsx src/retention-cli.ts <maxAgeDays> [--yes]
//   tsx src/retention-cli.ts hold <runId> <by> <reason...>
//   tsx src/retention-cli.ts lift <runId> <by>
async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await migrate(pool); // legal_holds table (003)
    const holds = new PostgresHoldStore(pool);
    const [, , first, ...rest] = process.argv;

    if (first === "hold") {
      const [runId, by, ...reason] = rest;
      if (!runId || !by || reason.length === 0) {
        console.error("usage: tsx src/retention-cli.ts hold <runId> <by> <reason...>");
        process.exit(2);
      }
      const placed = await holds.place(runId, by, reason.join(" "), Date.now());
      if (!placed.ok) throw new Error(placed.error);
      console.log(`hold placed on ${runId} by ${by}`);
      return;
    }
    if (first === "lift") {
      const [runId, by] = rest;
      if (!runId || !by) {
        console.error("usage: tsx src/retention-cli.ts lift <runId> <by>");
        process.exit(2);
      }
      const lifted = await holds.lift(runId, by, Date.now());
      if (!lifted.ok) throw new Error(lifted.error);
      console.log(`hold lifted from ${runId} by ${by} (history retained)`);
      return;
    }

    const maxAgeDays = Number(first);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      console.error("usage: tsx src/retention-cli.ts <maxAgeDays> [--yes]");
      process.exit(2);
    }
    const confirmed = rest.includes("--yes");
    const store = new PostgresEventStore(pool);
    const report = await applyRetention(
      store,
      holds,
      { maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000 },
      Date.now(),
      { dryRun: !confirmed },
    );
    const verb = confirmed ? "deleted" : "WOULD delete (dry run — pass --yes to apply)";
    console.log(`${verb}: ${report.deleted.length} run(s) ${JSON.stringify(report.deleted)}`);
    console.log(`skipped — held: ${report.skippedHeld.length}, active: ${report.skippedActive.length}, young: ${report.skippedYoung.length}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
