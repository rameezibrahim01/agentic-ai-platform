import pg from "pg";
import { parseEvent, replay } from "@platform/core";
import type { RunEvent } from "@platform/core";
import type {
  AppendResult,
  EventStore,
  LoadResult,
  RunFilter,
  RunSummary,
} from "./store.js";
import { migrate } from "./migrate.js";

/**
 * A stored row failed core's parseEvent — external tampering or a broken
 * writer. Named error so callers can catch it specifically instead of
 * receiving a bare zod exception from deep inside.
 */
export class CorruptEventLogError extends Error {
  constructor(
    readonly runId: string,
    readonly seq: number,
    detail: string,
  ) {
    super(`corrupt event log for run ${runId} at seq ${seq}: ${detail}`);
    this.name = "CorruptEventLogError";
  }
}

/**
 * EventStore on Postgres (ticket 006). Append is one transaction: a per-run
 * advisory lock serializes writers, the version check implements optimistic
 * concurrency, and the (run_id, seq) primary key is the backstop. Runs ticket
 * 002's conformance suite unchanged.
 */
export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: pg.Pool) {}

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
        "SELECT count(*)::int AS version FROM run_events WHERE run_id = $1",
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
          params.push(runId, expectedVersion + i, JSON.stringify(event));
          const base = i * 3;
          return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`;
        });
        await client.query(
          `INSERT INTO run_events (run_id, seq, event) VALUES ${tuples.join(", ")}`,
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
      "SELECT seq, event FROM run_events WHERE run_id = $1 ORDER BY seq",
      [runId],
    );
    if (result.rows.length === 0) return null;
    const events: RunEvent[] = [];
    for (const row of result.rows) {
      const parsed = parseEvent(row.event);
      if (!parsed.ok) {
        throw new CorruptEventLogError(runId, row.seq, JSON.stringify(parsed.issues));
      }
      events.push(parsed.event);
    }
    return { events, version: events.length };
  }

  async listRuns(filter?: RunFilter): Promise<RunSummary[]> {
    const result = await this.pool.query<{ run_id: string; events: unknown[] }>(
      "SELECT run_id, jsonb_agg(event ORDER BY seq) AS events FROM run_events GROUP BY run_id ORDER BY run_id",
    );
    const summaries: RunSummary[] = [];
    for (const row of result.rows) {
      const events: RunEvent[] = [];
      let corrupt = false;
      for (const raw of row.events) {
        const parsed = parseEvent(raw);
        if (!parsed.ok) {
          corrupt = true;
          break;
        }
        events.push(parsed.event);
      }
      if (corrupt) continue; // parity with InMemoryEventStore: skip unreplayable logs
      const replayed = replay(events);
      if (!replayed.ok) continue;
      const { state } = replayed;
      if (filter?.status !== undefined && state.status !== filter.status) continue;
      summaries.push({
        runId: row.run_id,
        status: state.status,
        steps: state.stepCount,
        costUsd: state.costUsd,
        version: events.length,
      });
    }
    return summaries;
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
): Promise<PostgresStoreHandle> {
  const pool = new pg.Pool({ connectionString });
  await migrate(pool);
  const store = new PostgresEventStore(pool);
  return { store, pool, close: () => pool.end() };
}
