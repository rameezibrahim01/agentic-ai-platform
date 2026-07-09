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
export type {
  AppendResult,
  EventStore,
  LoadResult,
  RunFilter,
  RunSummary,
} from "./store.js";

// The conformance suite is test-only (imports vitest) and lives behind the
// "@platform/storage/conformance" subpath — never import it from here.
