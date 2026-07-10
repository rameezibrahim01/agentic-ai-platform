import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryScoreStore, migrate, PostgresScoreStore } from "@platform/storage";
import type { RunScore, ScoreStore } from "@platform/storage";

// Ticket 029: one score per run is a LAW of the store, both adapters.

const SCORE: RunScore = {
  runId: "run-scored-1",
  agent: "triage@v1",
  rubricId: "quality@v1",
  judgeModel: "judge-pinned",
  scores: { resolution: 4, grounded: 3 },
  weightedScore: 3.5,
  scoredAt: 1_700_000_000_000,
};

function scoreStoreContract(name: string, make: () => Promise<ScoreStore>) {
  describe(`ScoreStore contract: ${name}`, () => {
    it("records once, refuses the second write, round-trips exactly", async () => {
      const store = await make();
      expect(await store.record(SCORE)).toEqual({ ok: true });
      expect(await store.record({ ...SCORE, weightedScore: 5 })).toEqual({
        ok: false,
        error: "already_scored",
      });
      expect(await store.get(SCORE.runId)).toEqual(SCORE);
      expect(await store.get("ghost")).toBeUndefined();
      expect(await store.list()).toEqual([SCORE]);
    });

    it("refuses out-of-range or malformed scores", async () => {
      const store = await make();
      const bad = { ...SCORE, runId: "run-bad", scores: { resolution: 9 } };
      expect((await store.record(bad)).ok).toBe(false);
      expect(await store.get("run-bad")).toBeUndefined();
    });
  });
}

scoreStoreContract("InMemoryScoreStore", async () => new InMemoryScoreStore());

const databaseUrl = process.env["TEST_DATABASE_URL"];
if (databaseUrl) {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await migrate(pool);
    await pool.query("TRUNCATE run_scores");
  });
  afterAll(async () => {
    await pool.end();
  });
  scoreStoreContract("PostgresScoreStore", async () => {
    await pool.query("TRUNCATE run_scores");
    return new PostgresScoreStore(pool);
  });
} else {
  console.warn(
    "[scores.test] SKIPPING PostgresScoreStore suite: TEST_DATABASE_URL is not set. CI runs this suite against a real Postgres service.",
  );
}
