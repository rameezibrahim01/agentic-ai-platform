import type pg from "pg";
import { schemaQualifier } from "./migrate.js";
import type { ScoreStore } from "./scores.js";
import type { EventStore } from "./store.js";

// Retention + legal hold (ticket 032). The event log is append-only WITHIN a
// run's lifetime (CLAUDE.md #5); retention is the deliberate, audited END of
// that lifetime: whole terminal runs, deleted by explicit policy, never
// edited. Legal hold inverts the priority — a held run survives every policy
// until the hold is lifted, and both acts are recorded facts.

export interface LegalHold {
  runId: string;
  placedBy: string;
  reason: string;
  /** epoch ms UTC */
  placedAt: number;
  liftedBy?: string;
  liftedAt?: number;
}

export type HoldResult = { ok: true; hold: LegalHold } | { ok: false; error: string };

export interface HoldStore {
  /** Refuses while an ACTIVE hold exists for the run. */
  place(runId: string, by: string, reason: string, at: number): Promise<HoldResult>;
  /** Sets lifted_by/lifted_at on the active hold; the row survives forever. */
  lift(runId: string, by: string, at: number): Promise<HoldResult>;
  isHeld(runId: string): Promise<boolean>;
  /** Full history, lifted holds included. */
  list(): Promise<LegalHold[]>;
}

export class InMemoryHoldStore implements HoldStore {
  private readonly holds: LegalHold[] = [];

  #active(runId: string): LegalHold | undefined {
    return this.holds.find((h) => h.runId === runId && h.liftedAt === undefined);
  }

  async place(runId: string, by: string, reason: string, at: number): Promise<HoldResult> {
    if (!runId || !by || !reason) return { ok: false, error: "runId, by, and reason are required" };
    if (this.#active(runId)) return { ok: false, error: "already_held" };
    const hold: LegalHold = { runId, placedBy: by, reason, placedAt: at };
    this.holds.push(hold);
    return { ok: true, hold };
  }

  async lift(runId: string, by: string, at: number): Promise<HoldResult> {
    const active = this.#active(runId);
    if (!active) return { ok: false, error: "not_held" };
    active.liftedBy = by;
    active.liftedAt = at;
    return { ok: true, hold: { ...active } };
  }

  async isHeld(runId: string): Promise<boolean> {
    return this.#active(runId) !== undefined;
  }

  async list(): Promise<LegalHold[]> {
    return this.holds.map((h) => ({ ...h }));
  }
}

interface HoldRow {
  run_id: string;
  placed_by: string;
  reason: string;
  placed_at: string | number;
  lifted_by: string | null;
  lifted_at: string | number | null;
}

const fromRow = (row: HoldRow): LegalHold => ({
  runId: row.run_id,
  placedBy: row.placed_by,
  reason: row.reason,
  placedAt: Number(row.placed_at),
  ...(row.lifted_by !== null ? { liftedBy: row.lifted_by } : {}),
  ...(row.lifted_at !== null ? { liftedAt: Number(row.lifted_at) } : {}),
});

export class PostgresHoldStore implements HoldStore {
  private readonly table: string;

  constructor(
    private readonly pool: pg.Pool,
    schema?: string,
  ) {
    this.table = `${schemaQualifier(schema)}legal_holds`;
  }

  async place(runId: string, by: string, reason: string, at: number): Promise<HoldResult> {
    if (!runId || !by || !reason) return { ok: false, error: "runId, by, and reason are required" };
    try {
      await this.pool.query(
        `INSERT INTO ${this.table} (run_id, placed_by, reason, placed_at) VALUES ($1, $2, $3, $4)`,
        [runId, by, reason, at],
      );
    } catch (error) {
      // the one-active partial unique index is the law
      if ((error as { code?: string }).code === "23505") return { ok: false, error: "already_held" };
      throw error;
    }
    return { ok: true, hold: { runId, placedBy: by, reason, placedAt: at } };
  }

  async lift(runId: string, by: string, at: number): Promise<HoldResult> {
    const result = await this.pool.query<HoldRow>(
      `UPDATE ${this.table} SET lifted_by = $2, lifted_at = $3
       WHERE run_id = $1 AND lifted_at IS NULL RETURNING *`,
      [runId, by, at],
    );
    const row = result.rows[0];
    return row === undefined ? { ok: false, error: "not_held" } : { ok: true, hold: fromRow(row) };
  }

  async isHeld(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.table} WHERE run_id = $1 AND lifted_at IS NULL`,
      [runId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(): Promise<LegalHold[]> {
    const result = await this.pool.query<HoldRow>(
      `SELECT * FROM ${this.table} ORDER BY run_id, placed_at`,
    );
    return result.rows.map(fromRow);
  }
}

export interface RetentionPolicy {
  /** Terminal runs whose LAST event is older than this are eligible. */
  maxAgeMs: number;
}

export interface RetentionReport {
  deleted: string[];
  /** Ticket 044: scores deleted alongside their runs — no orphaned observations. */
  deletedScores: string[];
  skippedHeld: string[];
  skippedActive: string[];
  skippedYoung: string[];
}

/**
 * The only deletion path. Whole terminal runs only: a running or
 * awaiting-approval run is never eligible regardless of age, a held run
 * survives every policy, and the report accounts for every run considered.
 */
export async function applyRetention(
  store: EventStore,
  holds: HoldStore,
  policy: RetentionPolicy,
  nowMs: number,
  options: { dryRun?: boolean; scores?: ScoreStore } = {},
): Promise<RetentionReport> {
  const report: RetentionReport = {
    deleted: [],
    deletedScores: [],
    skippedHeld: [],
    skippedActive: [],
    skippedYoung: [],
  };
  for (const summary of await store.listRuns()) {
    if (summary.status !== "completed" && summary.status !== "failed") {
      report.skippedActive.push(summary.runId);
      continue;
    }
    const loaded = await store.load(summary.runId);
    if (loaded === null || loaded.events.length === 0) continue;
    const endedAt = loaded.events[loaded.events.length - 1]!.at;
    if (nowMs - endedAt <= policy.maxAgeMs) {
      report.skippedYoung.push(summary.runId);
      continue;
    }
    if (await holds.isHeld(summary.runId)) {
      report.skippedHeld.push(summary.runId);
      continue;
    }
    if (!options.dryRun) {
      const deleted = await store.deleteRun(summary.runId);
      if (!deleted.ok) continue; // raced another retention pass; nothing to report
      if (options.scores !== undefined) {
        // after the log delete succeeds; a run without a score is not an error
        const scoreDeleted = await options.scores.delete(summary.runId);
        if (scoreDeleted.ok) report.deletedScores.push(summary.runId);
      }
    } else if (
      options.scores !== undefined &&
      (await options.scores.get(summary.runId)) !== undefined
    ) {
      report.deletedScores.push(summary.runId);
    }
    report.deleted.push(summary.runId);
  }
  return report;
}
