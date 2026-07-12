-- Ticket 040: SCIM-provisioned accounts. Per-deployment data (tenant is a
-- COLUMN, not a schema): the IdP owns the lifecycle, the record is
-- authoritative at login. Deactivation flips a bit — rows are never deleted,
-- so the provisioning history keeps its who.
CREATE TABLE IF NOT EXISTS accounts (
  username    text PRIMARY KEY,
  external_id text UNIQUE,
  roles       jsonb NOT NULL,
  tenant      text,
  active      boolean NOT NULL,
  updated_at  bigint NOT NULL
);
