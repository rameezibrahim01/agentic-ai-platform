-- Ticket 047: operator actions taken through the console (kill-switch flips
-- and their refusals). Append-only by convention: the codebase ships no
-- update or delete path for these rows — an unaudited emergency lever is how
-- audits are failed.
CREATE TABLE IF NOT EXISTS ops_audit (
  id        bigserial PRIMARY KEY,
  at        bigint NOT NULL,
  principal text NOT NULL,
  action    text NOT NULL,
  scope     text NOT NULL,
  detail    jsonb NOT NULL
);
