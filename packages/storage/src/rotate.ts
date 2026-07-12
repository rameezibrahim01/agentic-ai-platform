import type pg from "pg";
import type { EventCodec } from "./codec.js";
import { schemaQualifier } from "./migrate.js";

// Key rotation (ticket 043). Rotation changes the ENVELOPES, never the
// events and never their order (CLAUDE.md #5): every row is decoded with the
// old codec, re-encoded with the new one, and the decoded streams are
// verified byte-identical before anything commits. One transaction per run
// under the SAME advisory lock as append/deleteRun, so a run is only ever
// fully old-codec or fully new-codec — interrupted rotations resume, they
// never tear. Writers should be restarted onto the new key before rotating;
// the lock serializes them either way.

export interface RotateOptions {
  schema?: string;
  /** Do all the work, verify everything, write nothing. */
  dryRun?: boolean;
}

export type RotateRunResult =
  | { ok: true; outcome: "rotated" | "already_rotated"; events: number }
  | { ok: false; error: string };

const canonical = (value: unknown): string => JSON.stringify(value);

export async function rotateRun(
  pool: pg.Pool,
  runId: string,
  from: EventCodec,
  to: EventCodec,
  options: RotateOptions = {},
): Promise<RotateRunResult> {
  const table = `${schemaQualifier(options.schema)}run_events`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // the same lock append/deleteRun take: rotation never races a writer
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 42))", [runId]);
    const result = await client.query<{ seq: number; event: unknown }>(
      `SELECT seq, event FROM ${table} WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "not_found" };
    }

    // Per-row: a row already readable with the new codec is left untouched —
    // that covers resume after an interruption AND the legal mid-migration
    // state where a new-key writer appended after older rows (rotation is
    // per-run atomic for the rows it CHANGES; nothing is ever half-written).
    const updates: { seq: number; encoded: string }[] = [];
    for (const row of result.rows) {
      if (to.decode(row.event, { runId, seq: row.seq }).ok) continue; // already new-codec
      const decoded = from.decode(row.event, { runId, seq: row.seq });
      if (!decoded.ok) {
        await client.query("ROLLBACK");
        return { ok: false, error: `seq ${row.seq} is unreadable with the old codec (${decoded.reason})` };
      }
      const reEncoded = to.encode(decoded.event, { runId, seq: row.seq });
      // verify before write: the decoded stream must be byte-identical
      const roundTrip = to.decode(reEncoded, { runId, seq: row.seq });
      if (!roundTrip.ok || canonical(roundTrip.event) !== canonical(decoded.event)) {
        await client.query("ROLLBACK");
        return { ok: false, error: `seq ${row.seq} failed the re-encode verification` };
      }
      updates.push({ seq: row.seq, encoded: JSON.stringify(reEncoded) });
    }

    if (updates.length === 0) {
      await client.query("ROLLBACK");
      return { ok: true, outcome: "already_rotated", events: result.rows.length };
    }
    if (options.dryRun) {
      await client.query("ROLLBACK");
      return { ok: true, outcome: "rotated", events: updates.length };
    }
    for (const update of updates) {
      await client.query(
        `UPDATE ${table} SET event = $3::jsonb WHERE run_id = $1 AND seq = $2`,
        [runId, update.seq, update.encoded],
      );
    }
    await client.query("COMMIT");
    return { ok: true, outcome: "rotated", events: updates.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface RotateReport {
  rotated: string[];
  alreadyRotated: string[];
  failed: { runId: string; error: string }[];
}

/** Rotate every run in the store. A failed run stops nothing else — it is
 * named in the report, and the caller exits nonzero on any failure. */
export async function rotateStore(
  pool: pg.Pool,
  from: EventCodec,
  to: EventCodec,
  options: RotateOptions = {},
): Promise<RotateReport> {
  const table = `${schemaQualifier(options.schema)}run_events`;
  const runsResult = await pool.query<{ run_id: string }>(
    `SELECT DISTINCT run_id FROM ${table} ORDER BY run_id`,
  );
  const report: RotateReport = { rotated: [], alreadyRotated: [], failed: [] };
  for (const row of runsResult.rows) {
    const result = await rotateRun(pool, row.run_id, from, to, options);
    if (!result.ok) {
      report.failed.push({ runId: row.run_id, error: result.error });
    } else if (result.outcome === "already_rotated") {
      report.alreadyRotated.push(row.run_id);
    } else {
      report.rotated.push(row.run_id);
    }
  }
  return report;
}
