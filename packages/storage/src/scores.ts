import type pg from "pg";
import { z } from "zod";
import { schemaQualifier } from "./migrate.js";

// Score store (ticket 029): observations about runs, deliberately OUTSIDE
// the run event log — judging a run must leave its audit trail
// byte-identical. One score per run, enforced by the store.

export const runScoreSchema = z
  .object({
    runId: z.string().min(1),
    agent: z.string().min(1),
    rubricId: z.string().min(1),
    judgeModel: z.string().min(1),
    scores: z.record(z.number().min(0).max(5)),
    weightedScore: z.number().min(0).max(5),
    /** epoch ms UTC */
    scoredAt: z.number().int().nonnegative(),
  })
  .strict();

export type RunScore = z.infer<typeof runScoreSchema>;

export type RecordScoreResult =
  | { ok: true }
  | { ok: false; error: "already_scored" | string };

export interface ScoreStore {
  /** Refuses a second score for the same run — sampling never double-counts. */
  record(score: RunScore): Promise<RecordScoreResult>;
  get(runId: string): Promise<RunScore | undefined>;
  list(): Promise<RunScore[]>;
  /** The ONLY score-deletion path (ticket 044): scores die with their run.
   * Idempotent — a second delete is a typed miss, never an error. */
  delete(runId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }>;
}

export class InMemoryScoreStore implements ScoreStore {
  private readonly scores = new Map<string, RunScore>();

  async record(score: RunScore): Promise<RecordScoreResult> {
    const parsed = runScoreSchema.safeParse(score);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    if (this.scores.has(parsed.data.runId)) return { ok: false, error: "already_scored" };
    this.scores.set(parsed.data.runId, parsed.data);
    return { ok: true };
  }

  async get(runId: string): Promise<RunScore | undefined> {
    return this.scores.get(runId);
  }

  async list(): Promise<RunScore[]> {
    return [...this.scores.values()];
  }

  async delete(runId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
    return this.scores.delete(runId) ? { ok: true } : { ok: false, error: "not_found" };
  }
}

interface ScoreRow {
  run_id: string;
  agent: string;
  rubric_id: string;
  judge_model: string;
  scores: Record<string, number>;
  weighted_score: number;
  scored_at: string | number;
}

const fromRow = (row: ScoreRow): RunScore => ({
  runId: row.run_id,
  agent: row.agent,
  rubricId: row.rubric_id,
  judgeModel: row.judge_model,
  scores: row.scores,
  weightedScore: row.weighted_score,
  scoredAt: Number(row.scored_at),
});

/** Same contract on Postgres; the primary key is the one-score-per-run law. */
export class PostgresScoreStore implements ScoreStore {
  private readonly table: string;

  constructor(
    private readonly pool: pg.Pool,
    schema?: string,
  ) {
    this.table = `${schemaQualifier(schema)}run_scores`;
  }

  async record(score: RunScore): Promise<RecordScoreResult> {
    const parsed = runScoreSchema.safeParse(score);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    const s = parsed.data;
    const result = await this.pool.query(
      `INSERT INTO ${this.table} (run_id, agent, rubric_id, judge_model, scores, weighted_score, scored_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (run_id) DO NOTHING`,
      [s.runId, s.agent, s.rubricId, s.judgeModel, JSON.stringify(s.scores), s.weightedScore, s.scoredAt],
    );
    return result.rowCount === 1 ? { ok: true } : { ok: false, error: "already_scored" };
  }

  async get(runId: string): Promise<RunScore | undefined> {
    const result = await this.pool.query<ScoreRow>(
      `SELECT * FROM ${this.table} WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }

  async list(): Promise<RunScore[]> {
    const result = await this.pool.query<ScoreRow>(`SELECT * FROM ${this.table} ORDER BY run_id`);
    return result.rows.map(fromRow);
  }

  async delete(runId: string): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE run_id = $1`, [runId]);
    return (result.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, error: "not_found" };
  }
}
