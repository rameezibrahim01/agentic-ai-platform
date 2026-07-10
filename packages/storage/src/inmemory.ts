import { replay } from "@platform/core";
import type { RunEvent } from "@platform/core";
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
 */
export class InMemoryEventStore implements EventStore {
  readonly #logs = new Map<string, RunEvent[]>();

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
      this.#logs.set(runId, [...log, ...events.map((e) => structuredClone(e))]);
    }
    return { ok: true, version: log.length + events.length };
  }

  async load(runId: string): Promise<LoadResult | null> {
    const log = this.#logs.get(runId);
    if (log === undefined) return null;
    return { events: log.map((e) => structuredClone(e)), version: log.length };
  }

  async deleteRun(runId: string): Promise<DeleteRunResult> {
    if (!this.#logs.has(runId)) return { ok: false, error: "not_found" };
    this.#logs.delete(runId); // the whole run, atomically — never partial
    return { ok: true };
  }

  async listRuns(filter?: RunFilter): Promise<RunSummary[]> {
    const summaries: RunSummary[] = [];
    for (const [runId, events] of this.#logs) {
      const result = replay(events);
      if (!result.ok) continue; // engine-written logs always replay; skip anything else
      const { state } = result;
      if (filter?.status !== undefined && state.status !== filter.status) continue;
      summaries.push({
        runId,
        status: state.status,
        steps: state.stepCount,
        costUsd: state.costUsd,
        version: events.length,
      });
    }
    return summaries.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  }
}
