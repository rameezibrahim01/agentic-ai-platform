import type { RunEvent } from "@platform/core";
import type { EventStore } from "@platform/storage";

export type IdempotentAppendResult =
  | { ok: true; version: number; deduped: boolean }
  | { ok: false; error: string };

/**
 * At-least-once-safe append (CLAUDE.md #3). The idempotency key is
 * (runId, seq): `expectedVersion` doubles as the first event's seq, so a
 * retried activity whose previous attempt already landed sees a version
 * conflict, recognizes its own events in the log, and reports success
 * without appending again.
 */
export async function idempotentAppend(
  store: EventStore,
  runId: string,
  expectedVersion: number,
  events: readonly RunEvent[],
): Promise<IdempotentAppendResult> {
  const result = await store.append(runId, expectedVersion, events);
  if (result.ok) return { ok: true, version: result.version, deduped: false };

  const loaded = await store.load(runId);
  if (loaded && loaded.version >= expectedVersion + events.length) {
    const alreadyApplied = events.every((event, i) => {
      const stored = loaded.events[expectedVersion + i];
      return stored !== undefined && stored.seq === event.seq && stored.type === event.type;
    });
    if (alreadyApplied) {
      return { ok: true, version: expectedVersion + events.length, deduped: true };
    }
  }
  return {
    ok: false,
    error: `append conflict for ${runId}@${expectedVersion}: log advanced to ${
      result.conflict.actualVersion
    } with different events`,
  };
}
