import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ROLES, type Role } from "./roles.js";
import { principalFor, type Account } from "./accounts.js";

// Stateless HMAC-signed sessions. Pure apart from crypto: the clock is
// injected (nowMs), so expiry and round-trips are deterministic in tests.

export interface SessionClaims {
  sub: string;
  principal: string;
  roles: Role[];
  /** epoch ms UTC (CLAUDE.md #1) */
  exp: number;
}

const claimsSchema = z
  .object({
    sub: z.string().min(1),
    principal: z.string().min(1),
    roles: z.array(z.enum(ROLES)).min(1),
    exp: z.number().int().nonnegative(),
  })
  .strict();

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession(
  account: Account,
  ttlMs: number,
  secret: string,
  nowMs: number,
): string {
  return issueSessionFor(
    account.username,
    principalFor(account),
    account.roles,
    ttlMs,
    secret,
    nowMs,
  );
}

/** Same session mechanism, second front door (ticket 034): federated logins
 * carry the IdP subject as principal — one cookie format, one verifier. */
export function issueSessionFor(
  sub: string,
  principal: string,
  roles: readonly Role[],
  ttlMs: number,
  secret: string,
  nowMs: number,
): string {
  const claims: SessionClaims = { sub, principal, roles: [...roles], exp: nowMs + ttlMs };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export type SessionVerification =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "tampered" | "expired" };

export function verifySession(
  token: string,
  secret: string,
  nowMs: number,
): SessionVerification {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts;
  const expected = sign(payload!, secret);
  const signatureBuf = Buffer.from(signature!, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return { ok: false, reason: "tampered" };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.exp <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed.data };
}
