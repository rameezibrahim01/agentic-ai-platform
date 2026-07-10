import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgresEventStore } from "@platform/storage";
import { exportRuns, FORMATTERS, verifyExportChain } from "@platform/audit-export";
import type { ExportFormat } from "@platform/audit-export";

// Audit export CLI (ticket 031): stream the run event log in a SIEM-native
// format to stdout; the chain head hash goes to stderr — the value an
// auditor records out-of-band. Read-only: no migrations, no writes.
//   tsx src/audit-export-cli.ts <ndjson|splunk|datadog> [--anchor <hash>] [--since-seq <n>]
async function main(): Promise<void> {
  const [, , format, ...rest] = process.argv;
  if (format !== "ndjson" && format !== "splunk" && format !== "datadog") {
    console.error("usage: tsx src/audit-export-cli.ts <ndjson|splunk|datadog> [--anchor <hash>] [--since-seq <n>]");
    process.exit(2);
  }
  const anchorIndex = rest.indexOf("--anchor");
  const sinceIndex = rest.indexOf("--since-seq");
  const anchor = anchorIndex >= 0 ? rest[anchorIndex + 1] : undefined;
  const sinceSeq = sinceIndex >= 0 ? Number(rest[sinceIndex + 1]) : undefined;

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required — there is no log to export without a store");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const store = new PostgresEventStore(pool);
    const records = await exportRuns(store, {
      ...(anchor !== undefined ? { anchor } : {}),
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    });
    const formatter = FORMATTERS[format as ExportFormat];
    for (const record of records) process.stdout.write(`${formatter(record)}\n`);

    const verified = verifyExportChain(records, anchor);
    if (!verified.ok) throw new Error(`export self-check failed at record ${verified.brokenAt}`);
    console.error(`exported ${verified.records} records; chain head: ${verified.head}`);
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
