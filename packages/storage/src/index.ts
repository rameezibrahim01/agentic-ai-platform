export const STORAGE_READY = true;

export { InMemoryEventStore } from "./inmemory.js";
export {
  CorruptEventLogError,
  createPostgresEventStore,
  PostgresEventStore,
} from "./postgres.js";
export type { PostgresStoreHandle } from "./postgres.js";
export { migrate } from "./migrate.js";
export type { AppliedMigration } from "./migrate.js";
export { InMemoryScoreStore, PostgresScoreStore, runScoreSchema } from "./scores.js";
export type { RecordScoreResult, RunScore, ScoreStore } from "./scores.js";
export { applyRetention, InMemoryHoldStore, PostgresHoldStore } from "./retention.js";
export type {
  HoldResult,
  HoldStore,
  LegalHold,
  RetentionPolicy,
  RetentionReport,
} from "./retention.js";
export type {
  AppendResult,
  DeleteRunResult,
  EventStore,
  LoadResult,
  RunFilter,
  RunSummary,
} from "./store.js";

// The conformance suite is test-only (imports vitest) and lives behind the
// "@platform/storage/conformance" subpath — never import it from here.
