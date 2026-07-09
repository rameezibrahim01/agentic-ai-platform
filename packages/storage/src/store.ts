import type { RunEvent, RunStatus } from "@platform/core";

/**
 * Result of an optimistic-concurrency append: succeeds iff `expectedVersion`
 * equals the current log length (CLAUDE.md: typed results across boundaries).
 */
export type AppendResult =
  | { ok: true; version: number }
  | { ok: false; conflict: { actualVersion: number } };

export interface LoadResult {
  events: RunEvent[];
  /** Current log length; pass back as `expectedVersion` on the next append. */
  version: number;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  steps: number;
  costUsd: number;
  version: number;
}

export interface RunFilter {
  status?: RunStatus;
}

/**
 * Event-log storage contract (architecture §4). The store is append-only and
 * deliberately dumb: event legality is core's job (`reduce`/`replay`); the
 * store's job is durability and concurrency control. Async throughout because
 * the Postgres adapter (ticket 006) is.
 */
export interface EventStore {
  append(
    runId: string,
    expectedVersion: number,
    events: readonly RunEvent[],
  ): Promise<AppendResult>;
  load(runId: string): Promise<LoadResult | null>;
  listRuns(filter?: RunFilter): Promise<RunSummary[]>;
}
