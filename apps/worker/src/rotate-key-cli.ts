import { fileURLToPath } from "node:url";
import pg from "pg";
import { makeEncryptedEventCodec, plaintextCodec, rotateStore } from "@platform/storage";
import type { EventCodec } from "@platform/storage";
import { schemaFor } from "./tenants.js";

// Key rotation CLI (ticket 043). Re-encrypts a store's history from
// OLD_DATA_KEY to NEW_DATA_KEY — envelopes change, events never do, and an
// interrupted run resumes. Key material comes ONLY from env (CLAUDE.md #4);
// this prints counts, never keys or payloads. Restart the workers/console
// onto the new key BEFORE rotating (the per-run lock serializes either way,
// but a writer still holding the old key would append old-envelope rows).
//
//   OLD_DATA_KEY=<hex> NEW_DATA_KEY=<hex> tsx src/rotate-key-cli.ts [--tenant <id>] [--dry-run]
//
// An unset OLD_DATA_KEY means the store is plaintext today (adopting
// encryption late); an unset NEW_DATA_KEY decrypts back to plaintext.
async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  let schema: string | undefined;
  const tenantFlag = argv.indexOf("--tenant");
  if (tenantFlag !== -1) {
    const tenant = argv[tenantFlag + 1];
    if (!tenant) {
      console.error("--tenant requires a tenant id");
      process.exit(2);
    }
    schema = schemaFor(tenant);
    argv.splice(tenantFlag, 2);
  }
  const dryRun = argv.includes("--dry-run");

  const oldKey = process.env["OLD_DATA_KEY"];
  const newKey = process.env["NEW_DATA_KEY"];
  if (!oldKey && !newKey) {
    console.error("set OLD_DATA_KEY and/or NEW_DATA_KEY — rotating plaintext to plaintext is a no-op");
    process.exit(2);
  }
  const from: EventCodec = oldKey ? makeEncryptedEventCodec(oldKey) : plaintextCodec;
  const to: EventCodec = newKey ? makeEncryptedEventCodec(newKey) : plaintextCodec;

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const report = await rotateStore(pool, from, to, {
      ...(schema !== undefined ? { schema } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    });
    const scope = schema ?? "default schema";
    console.log(
      `${dryRun ? "DRY RUN — " : ""}rotation over ${scope}: ` +
        `${report.rotated.length} rotated, ${report.alreadyRotated.length} already rotated, ` +
        `${report.failed.length} failed`,
    );
    for (const failure of report.failed) {
      console.error(`FAILED ${failure.runId}: ${failure.error}`);
    }
    if (report.failed.length > 0) process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
