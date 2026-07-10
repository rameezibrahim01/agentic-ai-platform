import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionSecret } from "../../../../lib/auth";
import {
  getOidcRuntime,
  signTransient,
  TRANSIENT_COOKIE,
  TRANSIENT_TTL_MS,
} from "../../../../lib/oidc";

// Start the code flow (ticket 034): state + nonce ride in a short-lived
// signed cookie; the IdP round-trips them and the callback refuses any
// mismatch. Without OIDC_CONFIG this endpoint honestly 404s.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const runtime = await getOidcRuntime();
  if (runtime === null) {
    return NextResponse.json({ error: "SSO is not configured" }, { status: 404 });
  }

  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const redirectUri = new URL("/api/oidc/callback", request.url).toString();

  const authorize = new URL(runtime.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", runtime.config.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", runtime.config.scopes);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);

  const response = NextResponse.redirect(authorize, 303);
  response.cookies.set(
    TRANSIENT_COOKIE,
    signTransient({ state, nonce, exp: Date.now() + TRANSIENT_TTL_MS }, getSessionSecret()),
    { httpOnly: true, sameSite: "lax", path: "/", maxAge: TRANSIENT_TTL_MS / 1000 },
  );
  return response;
}
