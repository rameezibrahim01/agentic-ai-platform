import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  can,
  hashPassword,
  issueSession,
  parseAccountsFile,
  principalFor,
  ROLES,
  verifyPassword,
  verifySession,
  type Account,
  type Action,
  type Role,
} from "@platform/auth";

const passwordArb = fc.string({ minLength: 1, maxLength: 40 });
const accountArb: fc.Arbitrary<Account> = fc.record({
  username: fc.stringMatching(/^[a-z0-9._-]{1,20}$/),
  passwordHash: fc.constant("scrypt:00:00"), // sessions don't touch the hash
  roles: fc.uniqueArray(fc.constantFrom(...ROLES), { minLength: 1, maxLength: 5 }),
});

describe("passwords (scrypt)", () => {
  it("property: round-trip verifies; a different password is rejected", () => {
    fc.assert(
      fc.property(passwordArb, passwordArb, (password, other) => {
        const stored = hashPassword(password);
        expect(verifyPassword(password, stored)).toBe(true);
        if (other !== password) {
          expect(verifyPassword(other, stored)).toBe(false);
        }
      }),
      { numRuns: 25 }, // scrypt is deliberately slow
    );
  });

  it("malformed stored hashes are rejected, never a crash", () => {
    for (const bad of ["", "plain:abc", "scrypt:", "scrypt:zz:zz", "scrypt:00", "bcrypt:a:b"]) {
      expect(verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("two hashes of the same password differ (per-user salt)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});

describe("sessions (HMAC, injected clock)", () => {
  const SECRET = "test-secret";

  it("property: round-trip is deterministic and carries the account's claims", () => {
    fc.assert(
      fc.property(
        accountArb,
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 2 ** 44 }),
        (account, ttlMs, nowMs) => {
          const token = issueSession(account, ttlMs, SECRET, nowMs);
          const verified = verifySession(token, SECRET, nowMs);
          expect(verified).toEqual({
            ok: true,
            claims: {
              sub: account.username,
              principal: `user:${account.username}`,
              roles: account.roles,
              exp: nowMs + ttlMs,
            },
          });
        },
      ),
    );
  });

  it("expires exactly at ttl", () => {
    const account: Account = { username: "jane", passwordHash: "scrypt:00:00", roles: ["viewer"] };
    const token = issueSession(account, 1_000, SECRET, 50_000);
    expect(verifySession(token, SECRET, 50_999).ok).toBe(true);
    expect(verifySession(token, SECRET, 51_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("property: any single-character tamper is rejected", () => {
    const account: Account = { username: "jane", passwordHash: "scrypt:00:00", roles: ["viewer"] };
    const token = issueSession(account, 60_000, SECRET, 1_000);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: token.length - 1 }),
        fc.constantFrom(..."ABCXYZ0189_-"),
        (index, replacement) => {
          fc.pre(token[index] !== replacement);
          const tampered = token.slice(0, index) + replacement + token.slice(index + 1);
          const verified = verifySession(tampered, SECRET, 1_000);
          expect(verified.ok).toBe(false);
        },
      ),
    );
  });

  it("a token signed with a different secret is tampered; garbage is malformed", () => {
    const account: Account = { username: "jane", passwordHash: "scrypt:00:00", roles: ["viewer"] };
    const token = issueSession(account, 60_000, "other-secret", 1_000);
    expect(verifySession(token, SECRET, 1_000)).toEqual({ ok: false, reason: "tampered" });
    expect(verifySession("no-dot-here", SECRET, 1_000)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySession("", SECRET, 1_000)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("rbac: can()", () => {
  it("exhaustive over all five roles", () => {
    for (const role of ROLES) {
      expect(can([role], "view_runs")).toBe(true);
      expect(can([role], "manage_platform")).toBe(role === "platform_admin");
      expect(can([role], "approve_intents")).toBe(
        role === "approver" || role === "platform_admin",
      );
    }
  });

  it("no roles → deny; unknown action → deny", () => {
    expect(can([], "view_runs")).toBe(false);
    expect(can([...ROLES], "delete_everything" as Action)).toBe(false);
  });

  it("a role set is as strong as its strongest role", () => {
    const roles: Role[] = ["viewer", "platform_admin"];
    expect(can(roles, "manage_platform")).toBe(true);
  });
});

describe("accounts file", () => {
  it("valid file loads; principal matches the event model", () => {
    const result = parseAccountsFile({
      accounts: [{ username: "omar", passwordHash: "scrypt:aa:bb", roles: ["approver"] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(principalFor(result.accounts[0]!)).toBe("user:omar");
    }
  });

  it("malformed entries produce typed zod issues", () => {
    for (const bad of [
      {},
      { accounts: [] },
      { accounts: [{ username: "", passwordHash: "scrypt:a:b", roles: ["viewer"] }] },
      { accounts: [{ username: "x", passwordHash: "plaintext-password", roles: ["viewer"] }] },
      { accounts: [{ username: "x", passwordHash: "scrypt:a:b", roles: [] }] },
      { accounts: [{ username: "x", passwordHash: "scrypt:a:b", roles: ["root"] }] },
      { accounts: [{ username: "x", passwordHash: "scrypt:a:b", roles: ["viewer"], extra: 1 }] },
    ]) {
      const result = parseAccountsFile(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});
