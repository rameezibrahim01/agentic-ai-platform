import pg from "pg";
import { PostgresScoreStore } from "@platform/storage";
import type { RunScore } from "@platform/storage";
import { schemaForTenant } from "./tenancy";
import { isTenanted } from "./store";

// Score access for the console (ticket 029): DATABASE_URL → run_scores table
// (read-only viewer; the sampler owns writes). The in-memory demo profile
// has no sampler, so it truthfully shows "unsampled" — never fake scores.
// Tenanted deployments (038) read the SESSION tenant's run_scores schema;
// an unbound session gets no scores, same as no store.

let poolPromise: pg.Pool | null = null;

export async function loadScores(tenant?: string): Promise<RunScore[]> {
  const url = process.env["DATABASE_URL"];
  if (!url) return [];
  let schema: string | undefined;
  if (isTenanted()) {
    if (tenant === undefined) return [];
    schema = schemaForTenant(tenant);
  }
  poolPromise ??= new pg.Pool({ connectionString: url });
  try {
    return await new PostgresScoreStore(poolPromise, schema).list();
  } catch {
    // pre-029 databases have no run_scores table yet; the view stays honest
    return [];
  }
}
