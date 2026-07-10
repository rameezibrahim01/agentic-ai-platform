import type { PendingApprovalRow } from "./viewmodels.js";

// SLA surfacing (ticket 025): expiry defaults to DENY (ticket 017), so a
// silent inbox has a cost — an approval nobody saw times out to "no".
// State is derived from the log's own timestamps against an injected clock;
// nothing here mutates or extends the event model.

export type SlaState = "ok" | "expiring_soon" | "expired_pending_deny";

/** `expiring_soon` when less than 25% of the original ttl remains. */
export function slaState(requestedAt: number, expiresAt: number, nowMs: number): SlaState {
  if (nowMs >= expiresAt) return "expired_pending_deny";
  const ttl = expiresAt - requestedAt;
  const remaining = expiresAt - nowMs;
  return remaining < ttl * 0.25 ? "expiring_soon" : "ok";
}

export type SlaRow = PendingApprovalRow & { sla: SlaState };

/** Rows with SLA state, soonest-to-expire first. */
export function withSla(rows: readonly PendingApprovalRow[], nowMs: number): SlaRow[] {
  return rows
    .map((row) => ({ ...row, sla: slaState(row.requestedAt, row.expiresAt, nowMs) }))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}
