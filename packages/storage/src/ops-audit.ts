import type pg from "pg";
import { schemaQualifier } from "./migrate.js";

// Ops audit (ticket 047): who pulled which operator lever, when, on what.
// Append-only by convention — this module exposes record and list, nothing
// else, and nothing else in the codebase touches the table.

export interface OpsAuditRecord {
  /** epoch ms UTC (CLAUDE.md #1) */
  at: number;
  principal: string;
  action: string;
  scope: string;
  detail: Record<string, unknown>;
}

export interface OpsAuditStore {
  record(entry: OpsAuditRecord): Promise<void>;
  list(): Promise<OpsAuditRecord[]>;
}

export class InMemoryOpsAuditStore implements OpsAuditStore {
  private readonly entries: OpsAuditRecord[] = [];

  async record(entry: OpsAuditRecord): Promise<void> {
    this.entries.push({ ...entry, detail: { ...entry.detail } });
  }

  async list(): Promise<OpsAuditRecord[]> {
    return this.entries.map((e) => ({ ...e, detail: { ...e.detail } }));
  }
}

interface OpsAuditRow {
  at: string | number;
  principal: string;
  action: string;
  scope: string;
  detail: Record<string, unknown>;
}

export class PostgresOpsAuditStore implements OpsAuditStore {
  private readonly table: string;

  constructor(
    private readonly pool: pg.Pool,
    schema?: string,
  ) {
    this.table = `${schemaQualifier(schema)}ops_audit`;
  }

  async record(entry: OpsAuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (at, principal, action, scope, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [entry.at, entry.principal, entry.action, entry.scope, JSON.stringify(entry.detail)],
    );
  }

  async list(): Promise<OpsAuditRecord[]> {
    const result = await this.pool.query<OpsAuditRow>(
      `SELECT at, principal, action, scope, detail FROM ${this.table} ORDER BY id`,
    );
    return result.rows.map((row) => ({
      at: Number(row.at),
      principal: row.principal,
      action: row.action,
      scope: row.scope,
      detail: row.detail,
    }));
  }
}
