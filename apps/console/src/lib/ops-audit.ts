import pg from "pg";
import { PostgresOpsAuditStore } from "@platform/storage";
import type { OpsAuditStore } from "@platform/storage";

// Console-side ops audit access (ticket 047). No DATABASE_URL = no audit
// store = no flips: an unaudited emergency lever is refused, not allowed
// quietly. The worker owns migrations (005-ops-audit rides its boot).

let poolPromise: pg.Pool | null = null;

export function getOpsAudit(): OpsAuditStore | null {
  const url = process.env["DATABASE_URL"];
  if (!url) return null;
  poolPromise ??= new pg.Pool({ connectionString: url });
  return new PostgresOpsAuditStore(poolPromise);
}
