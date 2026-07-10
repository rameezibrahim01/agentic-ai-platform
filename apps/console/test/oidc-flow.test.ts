import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySession, type Jwks } from "@platform/auth";
import {
  handleOidcCallback,
  signTransient,
  verifyTransient,
  type CallbackDeps,
} from "../src/lib/oidc";

// Ticket 034: the callback's whole decision surface, unit-tested with an
// injected transport and JWKS — no IdP, no network.

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS: Jwks = {
  keys: [{ ...(publicKey.export({ format: "jwk" }) as { kty: "RSA"; n: string; e: string }), kid: "k1" }],
};

const NOW = 1_700_000_000_000;
const SESSION_SECRET = "console-session-secret";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
function idToken(overrides: Record<string, unknown> = {}): string {
  const header = { alg: "RS256", typ: "JWT", kid: "k1" };
  const payload = {
    iss: "https://idp.example",
    sub: "u-42",
    aud: "console-client",
    exp: NOW / 1000 + 600,
    nonce: "nonce-1",
    groups: ["platform-approvers"],
    ...overrides,
  };
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${cryptoSign("RSA-SHA256", Buffer.from(input, "utf8"), privateKey).toString("base64url")}`;
}

function deps(token: string, tokenStatus = 200): CallbackDeps & { requests: string[] } {
  const requests: string[] = [];
  return {
    issuer: "https://idp.example",
    clientId: "console-client",
    clientSecret: "cs-secret",
    tokenEndpoint: "https://idp.example/token",
    jwks: JWKS,
    mapping: {
      rolesClaim: "groups",
      roleMap: { "platform-approvers": ["approver"] },
      defaultRoles: ["viewer"],
    },
    sessionSecret: SESSION_SECRET,
    sessionTtlMs: 60_000,
    nowMs: () => NOW,
    requests,
    fetchFn: (async (_url: unknown, init?: RequestInit) => {
      requests.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ id_token: token }), {
        status: tokenStatus,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  };
}

const transient = () =>
  signTransient({ state: "st-1", nonce: "nonce-1", exp: NOW + 60_000 }, SESSION_SECRET);

const PARAMS = {
  code: "auth-code-1",
  state: "st-1",
  transientCookie: transient(),
  redirectUri: "https://console.example/api/oidc/callback",
};

describe("OIDC callback flow (ticket 034)", () => {
  it("success issues the standard 013 session with mapped roles and oidc:<sub> principal", async () => {
    const d = deps(idToken());
    const result = await handleOidcCallback(d, PARAMS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe("oidc:u-42");
    expect(result.roles).toEqual(["approver"]);
    const session = verifySession(result.sessionToken, SESSION_SECRET, NOW + 1);
    expect(session.ok && session.claims.principal).toBe("oidc:u-42");
    // the exchange carried the code + secret to the token endpoint, nowhere else
    expect(d.requests[0]).toContain("code=auth-code-1");
    expect(d.requests[0]).toContain("client_secret=cs-secret");
  });

  it("state mismatch, missing cookie, and expired attempts are refused before any exchange", async () => {
    const d1 = deps(idToken());
    expect(await handleOidcCallback(d1, { ...PARAMS, state: "st-FORGED" })).toMatchObject({
      ok: false,
      status: 401,
    });
    const d2 = deps(idToken());
    expect(await handleOidcCallback(d2, { ...PARAMS, transientCookie: null })).toMatchObject({
      ok: false,
      status: 401,
    });
    const stale = signTransient({ state: "st-1", nonce: "nonce-1", exp: NOW - 1 }, SESSION_SECRET);
    const d3 = deps(idToken());
    expect(await handleOidcCallback(d3, { ...PARAMS, transientCookie: stale })).toMatchObject({
      ok: false,
      status: 401,
    });
    expect([...d1.requests, ...d2.requests, ...d3.requests]).toEqual([]); // never exchanged
  });

  it("a nonce-mismatched or foreign-issuer id token is refused after exchange, typed", async () => {
    const wrongNonce = await handleOidcCallback(deps(idToken({ nonce: "evil" })), PARAMS);
    expect(wrongNonce).toEqual({ ok: false, status: 401, error: "id token rejected: bad_nonce" });
    const wrongIssuer = await handleOidcCallback(deps(idToken({ iss: "https://evil.example" })), PARAMS);
    expect(wrongIssuer).toMatchObject({ ok: false, status: 401 });
  });

  it("token-endpoint failures are typed 502s; unmapped users land on defaultRoles", async () => {
    expect(await handleOidcCallback(deps(idToken(), 500), PARAMS)).toMatchObject({
      ok: false,
      status: 502,
    });
    const unmapped = await handleOidcCallback(deps(idToken({ groups: ["strangers"] })), PARAMS);
    expect(unmapped.ok && unmapped.roles).toEqual(["viewer"]);
  });

  it("the transient cookie is HMAC-bound: tampering or a foreign secret yields null", () => {
    const value = transient();
    expect(verifyTransient(value, SESSION_SECRET, NOW)).toMatchObject({ state: "st-1" });
    expect(verifyTransient(`${value}x`, SESSION_SECRET, NOW)).toBeNull();
    expect(verifyTransient(value, "other-secret", NOW)).toBeNull();
    expect(verifyTransient(value, SESSION_SECRET, NOW + 120_000)).toBeNull(); // expired
  });
});
