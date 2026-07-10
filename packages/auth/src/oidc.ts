import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import { ROLES, type Role } from "./roles.js";

// OIDC id-token verification (ticket 034), pure and injected: the JWKS is a
// passed-in document and the clock is a number — fetching is the app's job,
// verification is math. RS256 only (the OIDC baseline every self-hostable
// issuer speaks); anything else is a typed refusal, never a fallback.

const jwkSchema = z
  .object({
    kty: z.literal("RSA"),
    n: z.string().min(1),
    e: z.string().min(1),
    kid: z.string().optional(),
    alg: z.string().optional(),
    use: z.string().optional(),
  })
  .passthrough();

export const jwksSchema = z.object({ keys: z.array(jwkSchema) }).passthrough();
export type Jwks = z.infer<typeof jwksSchema>;

const idClaimsSchema = z
  .object({
    iss: z.string().min(1),
    sub: z.string().min(1),
    aud: z.union([z.string(), z.array(z.string())]),
    /** epoch SECONDS, per the JWT spec. */
    exp: z.number(),
    nonce: z.string().optional(),
  })
  .passthrough();

export type IdTokenClaims = z.infer<typeof idClaimsSchema>;

export interface OidcVerifyOptions {
  issuer: string;
  audience: string;
  jwks: Jwks;
  nowMs: number;
  /** Required when the login flow sent one — a missing nonce then fails. */
  nonce?: string;
}

export type IdTokenVerification =
  | { ok: true; claims: IdTokenClaims }
  | {
      ok: false;
      reason:
        | "malformed"
        | "unsupported_algorithm"
        | "unknown_key"
        | "bad_signature"
        | "wrong_issuer"
        | "wrong_audience"
        | "expired"
        | "bad_nonce";
    };

const fromB64url = (part: string): Buffer => Buffer.from(part, "base64url");

export function verifyIdToken(token: string, options: OidcVerifyOptions): IdTokenVerification {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed" };
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: unknown;
  try {
    header = JSON.parse(fromB64url(rawHeader).toString("utf8")) as typeof header;
    payload = JSON.parse(fromB64url(rawPayload).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_algorithm" };

  const keys = options.jwks.keys.filter(
    (key) => header.kid === undefined || key.kid === header.kid,
  );
  if (keys.length === 0) return { ok: false, reason: "unknown_key" };

  const data = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
  const signature = fromB64url(rawSignature);
  const signedByKnownKey = keys.some((jwk) => {
    try {
      const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
      return cryptoVerify("RSA-SHA256", data, publicKey, signature);
    } catch {
      return false;
    }
  });
  if (!signedByKnownKey) return { ok: false, reason: "bad_signature" };

  const parsed = idClaimsSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const claims = parsed.data;

  if (claims.iss !== options.issuer) return { ok: false, reason: "wrong_issuer" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) return { ok: false, reason: "wrong_audience" };
  if (claims.exp * 1000 <= options.nowMs) return { ok: false, reason: "expired" };
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    return { ok: false, reason: "bad_nonce" };
  }
  return { ok: true, claims };
}

export interface OidcRoleMapping {
  /** Which claim carries the IdP's groups/roles (e.g. "groups"). */
  rolesClaim: string;
  /** IdP value → platform roles. Unlisted values grant NOTHING. */
  roleMap: Record<string, Role[]>;
  /** What an unmapped-but-authenticated user gets — viewer-class, never admin. */
  defaultRoles: Role[];
}

export const oidcRoleMappingSchema = z
  .object({
    rolesClaim: z.string().min(1),
    roleMap: z.record(z.array(z.enum(ROLES)).min(1)),
    defaultRoles: z.array(z.enum(ROLES)).min(1),
  })
  .strict();

/** Roles come from the CONFIG map alone — an IdP group grants platform roles
 * only if the map says so. */
export function mapOidcRoles(claims: IdTokenClaims, mapping: OidcRoleMapping): Role[] {
  const raw = (claims as Record<string, unknown>)[mapping.rolesClaim];
  const values = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  const mapped = new Set<Role>();
  for (const value of values) {
    for (const role of mapping.roleMap[value] ?? []) mapped.add(role);
  }
  return mapped.size > 0 ? [...mapped] : [...mapping.defaultRoles];
}

/** The audit's who for federated logins: `oidc:<sub>` — the IdP's subject. */
export function oidcPrincipal(claims: IdTokenClaims): string {
  return `oidc:${claims.sub}`;
}
