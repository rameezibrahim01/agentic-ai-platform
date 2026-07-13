export const STORAGE_READY = true;

export { InMemoryEventStore } from "./inmemory.js";
export { makeEncryptedEventCodec, plaintextCodec } from "./codec.js";
export type { DecodeResult, EventCodec, EventCodecContext } from "./codec.js";
export {
  CorruptEventLogError,
  createPostgresEventStore,
  PostgresEventStore,
} from "./postgres.js";
export type { PostgresStoreHandle } from "./postgres.js";
export { migrate } from "./migrate.js";
export type { AppliedMigration } from "./migrate.js";
export { rotateRun, rotateStore } from "./rotate.js";
export type { RotateOptions, RotateReport, RotateRunResult } from "./rotate.js";
export { InMemoryScoreStore, PostgresScoreStore, runScoreSchema } from "./scores.js";
export type { RecordScoreResult, RunScore, ScoreStore } from "./scores.js";
export { InMemoryAccountStore, PostgresAccountStore } from "./accounts.js";
export type { AccountRecord, AccountStore, UpsertAccountResult } from "./accounts.js";
export { InMemoryOpsAuditStore, PostgresOpsAuditStore } from "./ops-audit.js";
export type { OpsAuditRecord, OpsAuditStore } from "./ops-audit.js";
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
