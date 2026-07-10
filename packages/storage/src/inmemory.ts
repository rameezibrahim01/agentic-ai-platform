import { replay } from "@platform/core";
import type { RunEvent } from "@platform/core";
import { CorruptEventLogError, plaintextCodec } from "./codec.js";
import type { EventCodec } from "./codec.js";
import type {
  AppendResult,
  DeleteRunResult,
  EventStore,
  LoadResult,
  RunFilter,
  RunSummary,
} from "./store.js";

/**
 * Reference EventStore. Appends are atomic per run: the version check and the
 * write happen in one synchronous block (no awaits in between), so interleaved
 * writers can never produce a torn write — at most one same-version append wins.
 * Rows pass through the injected codec (ticket 035): plaintext by default,
 * encrypted when constructed with a key-bearing codec.
 */
export class InMemoryEventStore implements EventStore {
  readonly #logs = new Map<string, unknown[]>();
  readonly #codec: EventCodec;

  constructor(codec: EventCodec = plaintextCodec) {
    this.#codec = codec;
  }

  async append(
    runId: string,
    expectedVersion: number,
    events: readonly RunEvent[],
  ): Promise<AppendResult> {
    const log = this.#logs.get(runId) ?? [];
    if (expectedVersion !== log.length) {
      return { ok: false, conflict: { actualVersion: log.length } };
    }
    if (events.length > 0) {
      const encoded = events.map((event, i) =>
        structuredClone(this.#codec.encode(event, { runId, seq: expectedVersion + i })),
      );
      this.#logs.set(runId, [...log, ...encoded]);
    }
    return { ok: true, version: log.length + events.length };
  }

  #decodeLog(runId: string, log: unknown[]): RunEvent[] {
    return log.map((raw, seq) => {
      const decoded = this.#codec.decode(raw, { runId, seq });
      if (!decoded.ok) throw new CorruptEventLogError(runId, seq, decoded.reason);
      return decoded.event;
    });
  }

  async load(runId: string): Promise<LoadResult | null> {
    const log = this.#logs.get(runId);
    if (log === undefined) return null;
    return { events: this.#decodeLog(runId, log), version: log.length };
  }

  async deleteRun(runId: string): Promise<DeleteRunResult> {
    if (!this.#logs.has(runId)) return { ok: false, error: "not_found" };
    this.#logs.delete(runId); // the whole run, atomically — never partial
    return { ok: true };
  }

  async listRuns(filter?: RunFilter): Promise<RunSummary[]> {
    const summaries: RunSummary[] = [];
    for (const [runId, log] of this.#logs) {
      let events: RunEvent[];
      try {
        events = this.#decodeLog(runId, log);
      } catch {
        continue; // unreadable (e.g. revoked key) — honestly absent, never garbage
      }
      const result = replay(events);
      if (!result.ok) continue; // engine-written logs always replay; skip anything else
      const { state } = result;
      if (filter?.status !== undefined && state.status !== filter.status) continue;
      summaries.push({
        runId,
        status: state.status,
        steps: state.stepCount,
        costUsd: state.costUsd,
        version: log.length,
      });
    }
    return summaries.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  }
}
