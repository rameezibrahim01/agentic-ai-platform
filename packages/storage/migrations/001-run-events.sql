-- Append-only run event log (architecture §4). The primary key (run_id, seq)
-- is the last line of defense against torn writes; the adapter's transactional
-- append with an advisory lock is the first.
CREATE TABLE IF NOT EXISTS run_events (
  run_id text    NOT NULL,
  seq    integer NOT NULL CHECK (seq >= 0),
  event  jsonb   NOT NULL,
  PRIMARY KEY (run_id, seq)
);
