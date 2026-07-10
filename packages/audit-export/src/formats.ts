import type { ExportRecord } from "./chain.js";

// SIEM-native envelopes (ticket 031), all deriving from the SAME chained
// records — the chain fields travel inside every format, so verification
// works on whichever stream the customer ingested. Timestamps ISO-8601 UTC
// (CLAUDE.md #1).

const isoTime = (record: ExportRecord): string => new Date(record.event.at).toISOString();

export function toNdjsonLine(record: ExportRecord): string {
  return JSON.stringify({
    seq: record.seq,
    runId: record.runId,
    at: isoTime(record),
    event: record.event,
    prevHash: record.prevHash,
    hash: record.hash,
  });
}

/** Splunk HTTP Event Collector envelope. */
export function toSplunkHecLine(record: ExportRecord): string {
  return JSON.stringify({
    time: record.event.at / 1000, // HEC wants epoch seconds
    host: "agentic-platform",
    source: "run-event-log",
    sourcetype: "_json",
    event: {
      seq: record.seq,
      runId: record.runId,
      at: isoTime(record),
      event: record.event,
      prevHash: record.prevHash,
      hash: record.hash,
    },
  });
}

/** Datadog logs intake envelope. */
export function toDatadogLine(record: ExportRecord): string {
  return JSON.stringify({
    ddsource: "agentic-platform",
    service: "run-event-log",
    timestamp: isoTime(record),
    seq: record.seq,
    runId: record.runId,
    prevHash: record.prevHash,
    hash: record.hash,
    message: JSON.stringify(record.event),
  });
}

export type ExportFormat = "ndjson" | "splunk" | "datadog";

export const FORMATTERS: Record<ExportFormat, (record: ExportRecord) => string> = {
  ndjson: toNdjsonLine,
  splunk: toSplunkHecLine,
  datadog: toDatadogLine,
};
