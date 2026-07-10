import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  mapOidcRoles,
  oidcPrincipal,
  verifyIdToken,
  verifySession,
  issueSessionFor,
  type IdTokenClaims,
  type Jwks,
} from "@platform/auth";

// Ticket 034: id-token verification is math over injected inputs — every
// mismatch is a typed refusal, and roles come from the config map alone.

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

const JWK = { ...(publicKey.export({ format: "jwk" }) as { kty: "RSA"; n: string; e: string }), kid: "k1" };
const JWKS: Jwks = { keys: [JWK] };

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function signToken(
  payload: Record<string, unknown>,
  options: { key?: ReturnType<typeof createPrivateKey>; alg?: string; kid?: string } = {},
): string {
  const header = { alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? "k1" };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signature = cryptoSign(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    options.key ?? privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

const NOW = 1_700_000_000_000;
const BASE = {
  iss: "https://idp.example",
  sub: "u-123",
  aud: "console-client",
  exp: NOW / 1000 + 3600,
  nonce: "n-1",
  groups: ["platform-approvers"],
};
const OPTIONS = {
  issuer: "https://idp.example",
  audience: "console-client",
  jwks: JWKS,
  nowMs: NOW,
  nonce: "n-1",
};

describe("verifyIdToken (ticket 034)", () => {
  it("accepts a well-formed token and returns its claims", () => {
    const result = verifyIdToken(signToken(BASE), OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("u-123");
  });

  it("the refusal matrix: every mismatch has its own typed reason", () => {
    const cases: [string, string][] = [
      [signToken({ ...BASE, iss: "https://evil.example" }), "wrong_issuer"],
      [signToken({ ...BASE, aud: "someone-else" }), "wrong_audience"],
      [signToken({ ...BASE, exp: NOW / 1000 - 10 }), "expired"],
      [signToken({ ...BASE, nonce: "n-FORGED" }), "bad_nonce"],
      [signToken(BASE, { key: otherPair.privateKey as never }), "bad_signature"],
      [signToken(BASE, { alg: "none" }), "unsupported_algorithm"],
      [signToken(BASE, { kid: "unknown-kid" }), "unknown_key"],
      ["definitely.not-a.jwt", "malformed"],
    ];
    for (const [token, reason] of cases) {
      expect(verifyIdToken(token, OPTIONS)).toEqual({ ok: false, reason });
    }
  });

  it("property: any single-character tamper of the signed content is rejected", () => {
    const token = signToken(BASE);
    // the signature segment's final chars carry unused base64 bits (classic
    // b64 malleability — identical bytes after decode), so the property
    // covers the SIGNED portion: header + payload, where every char matters
    const signedLength = token.lastIndexOf(".");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: signedLength - 1 }),
        fc.constantFrom(..."ABCxyz0189_-"),
        (index, replacement) => {
          fc.pre(token[index] !== replacement && token[index] !== ".");
          const tampered = token.slice(0, index) + replacement + token.slice(index + 1);
          expect(verifyIdToken(tampered, OPTIONS).ok).toBe(false);
        },
      ),
    );
  });
});

describe("role mapping + federated sessions (ticket 034)", () => {
  const MAPPING = {
    rolesClaim: "groups",
    roleMap: { "platform-approvers": ["approver" as const], "platform-admins": ["platform_admin" as const] },
    defaultRoles: ["viewer" as const],
  };

  it("roles come from the map alone; unmapped users get viewer-class defaults", () => {
    const claims = { ...BASE } as unknown as IdTokenClaims;
    expect(mapOidcRoles(claims, MAPPING)).toEqual(["approver"]);
    const unmapped = { ...BASE, groups: ["random-idp-group"] } as unknown as IdTokenClaims;
    expect(mapOidcRoles(unmapped, MAPPING)).toEqual(["viewer"]); // never silent admin
    const noClaim = { ...BASE, groups: undefined } as unknown as IdTokenClaims;
    expect(mapOidcRoles(noClaim, MAPPING)).toEqual(["viewer"]);
    const both = { ...BASE, groups: ["platform-approvers", "platform-admins"] } as unknown as IdTokenClaims;
    expect(mapOidcRoles(both, MAPPING).sort()).toEqual(["approver", "platform_admin"]);
  });

  it("the federated session is the SAME 013 session: verifySession round-trips oidc:<sub>", () => {
    const claims = { ...BASE } as unknown as IdTokenClaims;
    const token = issueSessionFor(claims.sub, oidcPrincipal(claims), ["approver"], 1000, "s3cret", NOW);
    const verified = verifySession(token, "s3cret", NOW + 1);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims).toMatchObject({
        sub: "u-123",
        principal: "oidc:u-123", // the audit's who
        roles: ["approver"],
      });
    }
  });
});
