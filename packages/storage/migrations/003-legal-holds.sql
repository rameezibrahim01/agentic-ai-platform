-- Legal holds (ticket 032). Holds are FACTS with actor, reason, and time;
-- lifting sets lifted_at and the row survives forever — hold history is
-- itself audit material. One ACTIVE hold per run, enforced by the partial
-- unique index.
CREATE TABLE IF NOT EXISTS legal_holds (
  run_id    text   NOT NULL,
  placed_by text   NOT NULL,
  reason    text   NOT NULL,
  placed_at bigint NOT NULL,
  lifted_by text,
  lifted_at bigint,
  PRIMARY KEY (run_id, placed_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_holds_one_active
  ON legal_holds (run_id) WHERE lifted_at IS NULL;
