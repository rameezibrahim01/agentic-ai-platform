-- Online sampling scores (ticket 029). A SEPARATE table on purpose: scores
-- are observations ABOUT runs, not run events — the append-only run log
-- stays byte-identical when a run is judged. One score per run: sampling
-- must never double-bill or double-count.
CREATE TABLE IF NOT EXISTS run_scores (
  run_id         text             PRIMARY KEY,
  agent          text             NOT NULL,
  rubric_id      text             NOT NULL,
  judge_model    text             NOT NULL,
  scores         jsonb            NOT NULL,
  weighted_score double precision NOT NULL,
  scored_at      bigint           NOT NULL
);
