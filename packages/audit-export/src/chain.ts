import { createHash } from "node:crypto";
import type { RunEvent } from "@platform/core";

// The integrity chain (ticket 031): every exported record's hash covers its
// body AND its predecessor's hash, so an auditor holding only the head hash
// can detect truncation, reordering, or any byte of tampering in the whole
// stream — without trusting the exporter. "WORM" delivered honestly: math,
// not media.

export interface ExportRecord {
  /** Global position in this export stream, 0-based. */
  seq: number;
  runId: string;
  event: RunEvent;
  prevHash: string;
  hash: string;
}

/** Deterministic serialization: sorted keys, no undefined — same discipline
 * as the tool gateway's digests. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export const GENESIS_ANCHOR = "sha256:genesis";

function recordHash(seq: number, runId: string, event: RunEvent, prevHash: string): string {
  const body = canonical({ seq, runId, event });
  return `sha256:${createHash("sha256").update(prevHash + body, "utf8").digest("hex")}`;
}

/** Chain (runId, event) pairs, continuing from `anchor` at offset `startSeq`. */
export function chainRecords(
  entries: readonly { runId: string; event: RunEvent }[],
  anchor: string = GENESIS_ANCHOR,
  startSeq = 0,
): ExportRecord[] {
  const records: ExportRecord[] = [];
  let prevHash = anchor;
  entries.forEach((entry, index) => {
    const seq = startSeq + index;
    const hash = recordHash(seq, entry.runId, entry.event, prevHash);
    records.push({ seq, runId: entry.runId, event: entry.event, prevHash, hash });
    prevHash = hash;
  });
  return records;
}

export type ChainVerification =
  | { ok: true; head: string; records: number }
  | {
      ok: false;
      brokenAt: number;
      reason: "hash_mismatch" | "link_broken" | "seq_gap";
    };

/** Recompute every link; the FIRST broken record is named. */
export function verifyExportChain(
  records: readonly ExportRecord[],
  anchor: string = GENESIS_ANCHOR,
): ChainVerification {
  let prevHash = anchor;
  let expectedSeq = records[0]?.seq ?? 0;
  for (const record of records) {
    if (record.seq !== expectedSeq) {
      return { ok: false, brokenAt: record.seq, reason: "seq_gap" };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, brokenAt: record.seq, reason: "link_broken" };
    }
    const expected = recordHash(record.seq, record.runId, record.event, record.prevHash);
    if (record.hash !== expected) {
      return { ok: false, brokenAt: record.seq, reason: "hash_mismatch" };
    }
    prevHash = record.hash;
    expectedSeq += 1;
  }
  return { ok: true, head: prevHash, records: records.length };
}
