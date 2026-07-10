import type { EventStore } from "@platform/storage";
import type { RunEvent } from "@platform/core";
import { chainRecords, GENESIS_ANCHOR } from "./chain.js";
import type { ExportRecord } from "./chain.js";

// Export ordering is DETERMINISTIC: runs by runId, events by their own seq —
// the same store always yields the same stream, which is what makes the
// chain meaningful across repeated and incremental exports.

export interface ExportOptions {
  /** Continue a previous export's chain from this head hash. */
  anchor?: string;
  /** Global record index to start from (pairs with `anchor`). */
  sinceSeq?: number;
}

export async function exportRuns(
  store: EventStore,
  options: ExportOptions = {},
): Promise<ExportRecord[]> {
  const summaries = await store.listRuns();
  const ordered = [...summaries].sort((a, b) => (a.runId < b.runId ? -1 : 1));

  const entries: { runId: string; event: RunEvent }[] = [];
  for (const summary of ordered) {
    const loaded = await store.load(summary.runId);
    if (loaded === null) continue;
    for (const event of loaded.events) entries.push({ runId: summary.runId, event });
  }

  const sinceSeq = options.sinceSeq ?? 0;
  const anchor = options.anchor ?? GENESIS_ANCHOR;
  return chainRecords(entries.slice(sinceSeq), anchor, sinceSeq);
}
