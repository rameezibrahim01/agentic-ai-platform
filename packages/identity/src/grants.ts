import { z } from "zod";
import { riskTierSchema } from "@platform/core";
import { mintDelegation } from "./delegation.js";

// Standing delegation grants (architecture §7, ticket 020): scheduled runs
// break the live-session assumption — at 2 a.m. there is no user to exchange
// a token from. A standing grant is a first-class, auditable object in which
// a user pre-authorizes a specific schedule to act as them: named tools, a
// risk ceiling, MANDATORY expiry, permanent one-call revocation, and every
// exercise logged. What is never acceptable is a scheduler quietly running on
// a stored admin credential — a dead grant means the run proceeds with NO
// credential and the gateway refuses each governed intent.

const toolRefSchema = z
  .object({ name: z.string().min(1), version: z.string().min(1) })
  .strict();

export const standingGrantSchema = z
  .object({
    id: z.string().min(1),
    principal: z.string().min(1),
    /** The one schedule this grant authorizes — never a wildcard. */
    scheduleId: z.string().min(1),
    tools: z.array(toolRefSchema).min(1),
    risks: z.array(riskTierSchema).min(1),
    /** epoch ms UTC — required at construction; unexpiring grants do not exist. */
    expiresAt: z.number().int().positive(),
    /** epoch ms UTC — set once by revoke(), never cleared. */
    revokedAt: z.number().int().positive().optional(),
  })
  .strict();

export type StandingGrant = z.infer<typeof standingGrantSchema>;

export type GrantCreateResult =
  | { ok: true; grant: StandingGrant }
  | { ok: false; error: string };

export type GrantRevokeResult =
  | { ok: true; grant: StandingGrant }
  | { ok: false; error: "not_found" };

export interface GrantStore {
  /** Refuses anything that fails the schema — including a missing expiry. */
  create(grant: StandingGrant): Promise<GrantCreateResult>;
  get(id: string): Promise<StandingGrant | undefined>;
  /** One call, permanent: a second revoke keeps the FIRST revocation time. */
  revoke(id: string, at: number): Promise<GrantRevokeResult>;
  listForSchedule(scheduleId: string): Promise<StandingGrant[]>;
}

export class InMemoryGrantStore implements GrantStore {
  private readonly grants = new Map<string, StandingGrant>();

  async create(grant: StandingGrant): Promise<GrantCreateResult> {
    const parsed = standingGrantSchema.safeParse(grant);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    if (parsed.data.revokedAt !== undefined) {
      return { ok: false, error: "a grant cannot be created already revoked" };
    }
    if (this.grants.has(parsed.data.id)) {
      return { ok: false, error: `grant ${parsed.data.id} already exists` };
    }
    this.grants.set(parsed.data.id, parsed.data);
    return { ok: true, grant: parsed.data };
  }

  async get(id: string): Promise<StandingGrant | undefined> {
    return this.grants.get(id);
  }

  async revoke(id: string, at: number): Promise<GrantRevokeResult> {
    const existing = this.grants.get(id);
    if (existing === undefined) return { ok: false, error: "not_found" };
    if (existing.revokedAt !== undefined) return { ok: true, grant: existing };
    const revoked: StandingGrant = { ...existing, revokedAt: at };
    this.grants.set(id, revoked);
    return { ok: true, grant: revoked };
  }

  async listForSchedule(scheduleId: string): Promise<StandingGrant[]> {
    return [...this.grants.values()].filter((g) => g.scheduleId === scheduleId);
  }
}

/** The audit record of one exercise — recorded in the run's audited input. */
export interface GrantExercise {
  grantId: string;
  principal: string;
  scheduleId: string;
  runId: string;
  /** epoch ms UTC */
  at: number;
}

export type GrantExerciseResult =
  | { ok: true; delegation: string; exercise: GrantExercise }
  | { ok: false; reason: "revoked" | "expired" };

/**
 * Exercise a standing grant for one scheduled occurrence: mints a
 * per-occurrence delegation (ticket 019) with EXACTLY the grant's scope,
 * time-boxed to min(ttl, the grant's own expiry) — a delegation never
 * outlives the grant it came from. Revoked or expired grants mint nothing.
 */
export function exerciseGrant(
  grant: StandingGrant,
  occurrence: { runId: string; agent: string; env: string },
  ttlMs: number,
  secret: string,
  nowMs: number,
): GrantExerciseResult {
  if (grant.revokedAt !== undefined) return { ok: false, reason: "revoked" };
  if (grant.expiresAt <= nowMs) return { ok: false, reason: "expired" };
  const exp = Math.min(nowMs + ttlMs, grant.expiresAt);
  const delegation = mintDelegation(
    {
      principal: grant.principal,
      agent: occurrence.agent,
      env: occurrence.env,
      runId: occurrence.runId,
      tools: grant.tools,
      risks: grant.risks,
    },
    exp - nowMs,
    secret,
    nowMs,
  );
  return {
    ok: true,
    delegation,
    exercise: {
      grantId: grant.id,
      principal: grant.principal,
      scheduleId: grant.scheduleId,
      runId: occurrence.runId,
      at: nowMs,
    },
  };
}
