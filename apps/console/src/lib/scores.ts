import pg from "pg";
import { PostgresScoreStore } from "@platform/storage";
import type { RunScore } from "@platform/storage";

// Score access for the console (ticket 029): DATABASE_URL → run_scores table
// (read-only viewer; the sampler owns writes). The in-memory demo profile
// has no sampler, so it truthfully shows "unsampled" — never fake scores.

let poolPromise: pg.Pool | null = null;

export async function loadScores(): Promise<RunScore[]> {
  const url = process.env["DATABASE_URL"];
  if (!url) return [];
  poolPromise ??= new pg.Pool({ connectionString: url });
  try {
    return await new PostgresScoreStore(poolPromise).list();
  } catch {
    // pre-029 databases have no run_scores table yet; the view stays honest
    return [];
  }
}
