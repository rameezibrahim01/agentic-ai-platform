import type pg from "pg";
import { schemaQualifier } from "./migrate.js";

// Provisioned accounts (ticket 040): the SCIM endpoints write here and the
// login path reads here — the record is AUTHORITATIVE for federated logins.
// Storage stays auth-agnostic: roles are strings; @platform/auth validates
// them against its Role enum at the boundary.

export interface AccountRecord {
  username: string;
  /** The IdP's stable identifier (OIDC `sub`) — the deprovisioning join key. */
  externalId?: string;
  roles: string[];
  tenant?: string;
  active: boolean;
  /** epoch ms UTC (CLAUDE.md #1) */
  updatedAt: number;
}

export type UpsertAccountResult = { ok: true } | { ok: false; error: string };

export interface AccountStore {
  /** Insert or update by username. Never deletes; deactivation is an update. */
  upsert(record: AccountRecord): Promise<UpsertAccountResult>;
  get(username: string): Promise<AccountRecord | undefined>;
  getByExternalId(externalId: string): Promise<AccountRecord | undefined>;
  list(): Promise<AccountRecord[]>;
  /** Flip active=false; idempotent. Missing user is a typed miss. */
  deactivate(username: string, at: number): Promise<{ ok: true } | { ok: false; error: "not_found" }>;
}

export class InMemoryAccountStore implements AccountStore {
  private readonly records = new Map<string, AccountRecord>();

  async upsert(record: AccountRecord): Promise<UpsertAccountResult> {
    if (!record.username) return { ok: false, error: "username is required" };
    if (record.externalId !== undefined) {
      for (const existing of this.records.values()) {
        if (existing.externalId === record.externalId && existing.username !== record.username) {
          return { ok: false, error: "external_id_conflict" };
        }
      }
    }
    this.records.set(record.username, { ...record });
    return { ok: true };
  }

  async get(username: string): Promise<AccountRecord | undefined> {
    const record = this.records.get(username);
    return record === undefined ? undefined : { ...record };
  }

  async getByExternalId(externalId: string): Promise<AccountRecord | undefined> {
    for (const record of this.records.values()) {
      if (record.externalId === externalId) return { ...record };
    }
    return undefined;
  }

  async list(): Promise<AccountRecord[]> {
    return [...this.records.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async deactivate(
    username: string,
    at: number,
  ): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
    const record = this.records.get(username);
    if (record === undefined) return { ok: false, error: "not_found" };
    record.active = false;
    record.updatedAt = at;
    return { ok: true };
  }
}

interface AccountRow {
  username: string;
  external_id: string | null;
  roles: string[];
  tenant: string | null;
  active: boolean;
  updated_at: string | number;
}

const fromRow = (row: AccountRow): AccountRecord => ({
  username: row.username,
  ...(row.external_id !== null ? { externalId: row.external_id } : {}),
  roles: row.roles,
  ...(row.tenant !== null ? { tenant: row.tenant } : {}),
  active: row.active,
  updatedAt: Number(row.updated_at),
});

export class PostgresAccountStore implements AccountStore {
  private readonly table: string;

  constructor(
    private readonly pool: pg.Pool,
    schema?: string,
  ) {
    this.table = `${schemaQualifier(schema)}accounts`;
  }

  async upsert(record: AccountRecord): Promise<UpsertAccountResult> {
    if (!record.username) return { ok: false, error: "username is required" };
    try {
      await this.pool.query(
        `INSERT INTO ${this.table} (username, external_id, roles, tenant, active, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         ON CONFLICT (username) DO UPDATE SET
           external_id = EXCLUDED.external_id,
           roles = EXCLUDED.roles,
           tenant = EXCLUDED.tenant,
           active = EXCLUDED.active,
           updated_at = EXCLUDED.updated_at`,
        [
          record.username,
          record.externalId ?? null,
          JSON.stringify(record.roles),
          record.tenant ?? null,
          record.active,
          record.updatedAt,
        ],
      );
    } catch (error) {
      // the unique index on external_id is the law: one IdP identity, one account
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, error: "external_id_conflict" };
      }
      throw error;
    }
    return { ok: true };
  }

  async get(username: string): Promise<AccountRecord | undefined> {
    const result = await this.pool.query<AccountRow>(
      `SELECT * FROM ${this.table} WHERE username = $1`,
      [username],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }

  async getByExternalId(externalId: string): Promise<AccountRecord | undefined> {
    const result = await this.pool.query<AccountRow>(
      `SELECT * FROM ${this.table} WHERE external_id = $1`,
      [externalId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : fromRow(row);
  }

  async list(): Promise<AccountRecord[]> {
    const result = await this.pool.query<AccountRow>(
      `SELECT * FROM ${this.table} ORDER BY username`,
    );
    return result.rows.map(fromRow);
  }

  async deactivate(
    username: string,
    at: number,
  ): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
    const result = await this.pool.query(
      `UPDATE ${this.table} SET active = false, updated_at = $2 WHERE username = $1`,
      [username, at],
    );
    return (result.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, error: "not_found" };
  }
}
