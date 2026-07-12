import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  applyRetention,
  makeEncryptedEventCodec,
  migrate,
  PostgresEventStore,
  PostgresHoldStore,
  PostgresScoreStore,
} from "@platform/storage";
import type { EventStore, HoldStore, ScoreStore } from "@platform/storage";
import { openTenantStore, parseTenantsConfig } from "./tenants.js";

// Retention CLI (ticket 032, extended by 044). DRY-RUN by default — deletion
// demands an explicit --yes. Scores die with their runs (044): the same pass
// that deletes a run deletes its run_scores row, and holds protect both.
// Tenanted deployments (036): --tenant <id> resolves that tenant's
// schema-scoped stores (and key) from TENANTS_CONFIG.
//   tsx src/retention-cli.ts <maxAgeDays> [--yes] [--tenant <id>]
//   tsx src/retention-cli.ts hold <runId> <by> <reason...> [--tenant <id>]
//   tsx src/retention-cli.ts lift <runId> <by> [--tenant <id>]
async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  let tenant: string | undefined;
  const tenantFlag = argv.indexOf("--tenant");
  if (tenantFlag !== -1) {
    tenant = argv[tenantFlag + 1];
    if (!tenant) {
      console.error("--tenant requires a tenant id");
      process.exit(2);
    }
    argv.splice(tenantFlag, 2);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    let store: EventStore;
    let scores: ScoreStore;
    let holds: HoldStore;
    if (tenant !== undefined) {
      const tenantsPath = process.env["TENANTS_CONFIG"];
      if (!tenantsPath) {
        console.error("--tenant requires TENANTS_CONFIG");
        process.exit(2);
      }
      const parsed = parseTenantsConfig(JSON.parse(await readFile(tenantsPath, "utf8")));
      if (!parsed.ok) throw new Error(parsed.error);
      const spec = parsed.config.tenants.find((t) => t.id === tenant);
      if (spec === undefined) throw new Error(`tenant ${tenant} is not in TENANTS_CONFIG`);
      const opened = await openTenantStore(pool, spec); // that tenant's schema + key only
      store = opened.store;
      scores = opened.scores;
      holds = opened.holds;
    } else {
      await migrate(pool);
      // read through the deployment key when one is set (035) — retention
      // must be able to LOAD runs to find their terminal timestamps
      const dataKey = process.env["PLATFORM_DATA_KEY"];
      store = new PostgresEventStore(pool, dataKey ? makeEncryptedEventCodec(dataKey) : undefined);
      scores = new PostgresScoreStore(pool);
      holds = new PostgresHoldStore(pool);
    }

    const [first, ...rest] = argv;

    if (first === "hold") {
      const [runId, by, ...reason] = rest;
      if (!runId || !by || reason.length === 0) {
        console.error("usage: tsx src/retention-cli.ts hold <runId> <by> <reason...> [--tenant <id>]");
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
        console.error("usage: tsx src/retention-cli.ts lift <runId> <by> [--tenant <id>]");
        process.exit(2);
      }
      const lifted = await holds.lift(runId, by, Date.now());
      if (!lifted.ok) throw new Error(lifted.error);
      console.log(`hold lifted from ${runId} by ${by} (history retained)`);
      return;
    }

    const maxAgeDays = Number(first);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      console.error("usage: tsx src/retention-cli.ts <maxAgeDays> [--yes] [--tenant <id>]");
      process.exit(2);
    }
    const confirmed = rest.includes("--yes");
    const report = await applyRetention(
      store,
      holds,
      { maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000 },
      Date.now(),
      { dryRun: !confirmed, scores },
    );
    const verb = confirmed ? "deleted" : "WOULD delete (dry run — pass --yes to apply)";
    const scope = tenant !== undefined ? ` [tenant ${tenant}]` : "";
    console.log(`${verb}${scope}: ${report.deleted.length} run(s) ${JSON.stringify(report.deleted)}`);
    console.log(`scores ${confirmed ? "deleted" : "affected"}: ${report.deletedScores.length}`);
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
