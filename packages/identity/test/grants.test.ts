import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  exerciseGrant,
  InMemoryGrantStore,
  verifyDelegation,
  workloadIdentityFor,
  type StandingGrant,
} from "@platform/identity";

const SECRET = "grant-test-secret";

const GRANT: StandingGrant = {
  id: "grant-nightly-1",
  principal: "user:oncall",
  scheduleId: "nightly-triage",
  tools: [{ name: "ticket.update", version: "v1" }],
  risks: ["read", "write"],
  expiresAt: 2_000_000,
};

const OCCURRENCE = { runId: "nightly-triage-2026-07-11T02:00:00Z", agent: "triage@v1", env: "prod" };

describe("standing grants (ticket 020)", () => {
  it("grants cannot be constructed without expiry — runtime refusal", async () => {
    const store = new InMemoryGrantStore();
    const { expiresAt: _dropped, ...noExpiry } = GRANT;
    const result = await store.create(noExpiry as StandingGrant);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expiresAt");
    expect(await store.get(GRANT.id)).toBeUndefined();
  });

  it("create refuses duplicates and pre-revoked grants; listForSchedule filters", async () => {
    const store = new InMemoryGrantStore();
    expect((await store.create(GRANT)).ok).toBe(true);
    expect((await store.create(GRANT)).ok).toBe(false); // duplicate id
    expect((await store.create({ ...GRANT, id: "g2", revokedAt: 1 })).ok).toBe(false);
    await store.create({ ...GRANT, id: "g3", scheduleId: "other-schedule" });

    const forSchedule = await store.listForSchedule(GRANT.scheduleId);
    expect(forSchedule.map((g) => g.id)).toEqual([GRANT.id]);
  });

  it("revocation is one call and permanent — a second revoke keeps the first time", async () => {
    const store = new InMemoryGrantStore();
    await store.create(GRANT);
    const first = await store.revoke(GRANT.id, 100);
    expect(first.ok && first.grant.revokedAt).toBe(100);
    const second = await store.revoke(GRANT.id, 200);
    expect(second.ok && second.grant.revokedAt).toBe(100); // permanent, not re-stamped
    expect((await store.get(GRANT.id))?.revokedAt).toBe(100);
    expect(await store.revoke("ghost", 100)).toEqual({ ok: false, error: "not_found" });
  });

  it("exercise: valid → delegation with exactly the grant's scope, per-occurrence runId", () => {
    const nowMs = 1_000_000;
    const result = exerciseGrant(GRANT, OCCURRENCE, 60_000, SECRET, nowMs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.exercise).toEqual({
      grantId: GRANT.id,
      principal: GRANT.principal,
      scheduleId: GRANT.scheduleId,
      runId: OCCURRENCE.runId,
      at: nowMs,
    });
    const verified = verifyDelegation(result.delegation, SECRET, nowMs);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims).toEqual({
        principal: GRANT.principal,
        agent: OCCURRENCE.agent,
        env: OCCURRENCE.env,
        presenter: workloadIdentityFor(OCCURRENCE.agent, OCCURRENCE.env),
        runId: OCCURRENCE.runId,
        tools: GRANT.tools,
        risks: GRANT.risks,
        exp: nowMs + 60_000,
      });
    }
  });

  it("property: the minted delegation's expiry is min(ttl, grant expiry) — never beyond the grant", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }), // ttlMs
        fc.integer({ min: 0, max: 2 ** 44 }), // nowMs
        fc.integer({ min: 1, max: 10_000_000_000 }), // grant lifetime remaining
        (ttlMs, nowMs, remainingMs) => {
          const grant: StandingGrant = { ...GRANT, expiresAt: nowMs + remainingMs };
          const result = exerciseGrant(grant, OCCURRENCE, ttlMs, SECRET, nowMs);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const verified = verifyDelegation(result.delegation, SECRET, nowMs);
          expect(verified.ok).toBe(true);
          if (verified.ok) {
            expect(verified.claims.exp).toBe(Math.min(nowMs + ttlMs, grant.expiresAt));
            expect(verified.claims.exp).toBeLessThanOrEqual(grant.expiresAt);
          }
        },
      ),
    );
  });

  it("exercise refuses revoked and expired grants — typed, no delegation minted", () => {
    const revoked = exerciseGrant({ ...GRANT, revokedAt: 500 }, OCCURRENCE, 60_000, SECRET, 1_000);
    expect(revoked).toEqual({ ok: false, reason: "revoked" });

    const expired = exerciseGrant(GRANT, OCCURRENCE, 60_000, SECRET, GRANT.expiresAt);
    expect(expired).toEqual({ ok: false, reason: "expired" });
    // just before expiry still works, capped at the boundary
    const edge = exerciseGrant(GRANT, OCCURRENCE, 60_000, SECRET, GRANT.expiresAt - 1);
    expect(edge.ok).toBe(true);
    if (edge.ok) {
      const verified = verifyDelegation(edge.delegation, SECRET, GRANT.expiresAt - 1);
      expect(verified.ok && verified.claims.exp).toBe(GRANT.expiresAt);
    }
  });
});
