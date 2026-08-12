import pg from "pg";
import { replay } from "@platform/core";
import type { RunEvent } from "@platform/core";
import { CorruptEventLogError, plaintextCodec } from "./codec.js";
import { schemaQualifier } from "./migrate.js";
import type { EventCodec } from "./codec.js";
import type {
  AppendResult,
  DeleteRunResult,
  EventStore,
  LoadResult,
  RunFilter,
  RunSummary,
} from "./store.js";
import { migrate } from "./migrate.js";

export { CorruptEventLogError } from "./codec.js";

/**
 * EventStore on Postgres (ticket 006). Append is one transaction: a per-run
 * advisory lock serializes writers, the version check implements optimistic
 * concurrency, and the (run_id, seq) primary key is the backstop. Runs ticket
 * 002's conformance suite unchanged.
 */
export class PostgresEventStore implements EventStore {
  private readonly table: string;

  constructor(
    private readonly pool: pg.Pool,
    private readonly codec: EventCodec = plaintextCodec,
    schema?: string,
  ) {
    this.table = `${schemaQualifier(schema)}run_events`;
  }

  async append(
    runId: string,
    expectedVersion: number,
    events: readonly RunEvent[],
  ): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 42))", [runId]);
      const versionResult = await client.query<{ version: number }>(
        `SELECT count(*)::int AS version FROM ${this.table} WHERE run_id = $1`,
        [runId],
      );
      const actualVersion = versionResult.rows[0]?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        await client.query("ROLLBACK");
        return { ok: false, conflict: { actualVersion } };
      }
      if (events.length > 0) {
        const params: unknown[] = [];
        const tuples = events.map((event, i) => {
          const seq = expectedVersion + i;
          params.push(runId, seq, JSON.stringify(this.codec.encode(event, { runId, seq })));
          const base = i * 3;
          return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`;
        });
        await client.query(
          `INSERT INTO ${this.table} (run_id, seq, event) VALUES ${tuples.join(", ")}`,
          params,
        );
      }
      await client.query("COMMIT");
      return { ok: true, version: expectedVersion + events.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async load(runId: string): Promise<LoadResult | null> {
    const result = await this.pool.query<{ seq: number; event: unknown }>(
      `SELECT seq, event FROM ${this.table} WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    if (result.rows.length === 0) return null;
    const events: RunEvent[] = [];
    for (const row of result.rows) {
      const decoded = this.codec.decode(row.event, { runId, seq: row.seq });
      if (!decoded.ok) {
        throw new CorruptEventLogError(runId, row.seq, decoded.reason);
      }
      events.push(decoded.event);
    }
    return { events, version: events.length };
  }

  async deleteRun(runId: string): Promise<DeleteRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // same advisory lock as append: retention never races a writer
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 42))", [runId]);
      const result = await client.query(`DELETE FROM ${this.table} WHERE run_id = $1`, [runId]);
      await client.query("COMMIT");
      return result.rowCount && result.rowCount > 0
        ? { ok: true }
        : { ok: false, error: "not_found" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listRuns(filter?: RunFilter): Promise<RunSummary[]> {
    // Ticket 066 — two-event skim first: only the seq-0 event (ordering:
    // startedAt) and the LAST event (status) are decoded per run, so a page
    // never loads or replays non-page logs. Works identically for encrypted
    // codecs, which SQL alone could not order or filter.
    const skim = await this.pool.query<{
      run_id: string;
      version: number;
      first: unknown;
      last: unknown;
      last_seq: number;
    }>(
      `SELECT r.run_id, r.version, r.last_seq, e0.event AS first, e1.event AS last
       FROM (SELECT run_id, count(*)::int AS version, max(seq)::int AS last_seq
             FROM ${this.table} GROUP BY run_id) r
       JOIN ${this.table} e0 ON e0.run_id = r.run_id AND e0.seq = 0
       JOIN ${this.table} e1 ON e1.run_id = r.run_id AND e1.seq = r.last_seq`,
    );
    const candidates: { runId: string; startedAt: number; status: RunSummary["status"] }[] = [];
    for (const row of skim.rows) {
      const first = this.codec.decode(row.first, { runId: row.run_id, seq: 0 });
      const last = this.codec.decode(row.last, { runId: row.run_id, seq: row.last_seq });
      // undecodable or malformed logs are honestly absent, never garbage
      if (!first.ok || !last.ok || first.event.type !== "RunStarted") continue;
      const status = statusFromLastEvent(last.event);
      if (filter?.status !== undefined && status !== filter.status) continue;
      candidates.push({ runId: row.run_id, startedAt: first.event.at, status });
    }
    // the contract ordering (ticket 066): newest-first, runId as tiebreak
    candidates.sort(
      (a, b) =>
        b.startedAt - a.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
    );
    const offset = filter?.offset ?? 0;
    const page = candidates.slice(
      offset,
      filter?.limit !== undefined ? offset + filter.limit : undefined,
    );

    // full load + replay for PAGE runs only — steps/cost/tokens need the log
    const summaries: RunSummary[] = [];
    for (const candidate of page) {
      let loaded: LoadResult | null;
      try {
        loaded = await this.load(candidate.runId);
      } catch {
        continue; // decodable head but corrupt tail — parity with the skim rule
      }
      if (loaded === null) continue;
      const replayed = replay(loaded.events);
      if (!replayed.ok) continue;
      const { state } = replayed;
      summaries.push({
        runId: candidate.runId,
        status: state.status,
        steps: state.stepCount,
        costUsd: state.costUsd,
        version: loaded.version,
        startedAt: state.startedAt,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
      });
    }
    return summaries;
  }
}

/** The run's status read off its LAST event — replay's rules, one event.
 * Legal engine-written logs make this exact; anything else never got here
 * (the seq-0/type checks above skip it). */
function statusFromLastEvent(event: RunEvent): RunSummary["status"] {
  switch (event.type) {
    case "RunCompleted":
      return "completed";
    case "RunFailed":
      return "failed";
    case "ApprovalRequested":
    case "ApprovalEscalated":
    case "ApprovalDelegated":
      return "awaiting_approval";
    default:
      return "running";
  }
}

export interface PostgresStoreHandle {
  store: PostgresEventStore;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Connect, run forward-only migrations, return a ready store. */
export async function createPostgresEventStore(
  connectionString: string,
  codec?: EventCodec,
  schema?: string,
): Promise<PostgresStoreHandle> {
  const pool = new pg.Pool({ connectionString });
  await migrate(pool, schema !== undefined ? { schema } : {});
  const store = new PostgresEventStore(pool, codec, schema);
  return { store, pool, close: () => pool.end() };
}
