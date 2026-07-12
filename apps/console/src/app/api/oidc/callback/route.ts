import { NextResponse, type NextRequest } from "next/server";
import { getSessionSecret, SESSION_COOKIE, SESSION_TTL_MS } from "../../../../lib/auth";
import { getOidcRuntime, handleOidcCallback, TRANSIENT_COOKIE } from "../../../../lib/oidc";
import { isTenanted } from "../../../../lib/store";

// Finish the code flow (ticket 034). All decisions live in
// handleOidcCallback (unit-tested with injected transport + JWKS); this
// adapter extracts the request parts and sets the STANDARD 013 session
// cookie — approvals and audit see `oidc:<sub>` as the who.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const runtime = await getOidcRuntime();
  if (runtime === null) {
    return NextResponse.json({ error: "SSO is not configured" }, { status: 404 });
  }

  const url = new URL(request.url);
  const result = await handleOidcCallback(
    {
      issuer: runtime.config.issuer,
      clientId: runtime.config.clientId,
      clientSecret: runtime.clientSecret,
      tokenEndpoint: runtime.tokenEndpoint,
      jwks: runtime.jwks,
      mapping: {
        rolesClaim: runtime.config.rolesClaim,
        roleMap: runtime.config.roleMap,
        defaultRoles: runtime.config.defaultRoles,
      },
      tenanted: isTenanted(),
      ...(runtime.config.tenantClaim !== undefined && runtime.config.tenantMap !== undefined
        ? {
            tenantMapping: {
              tenantClaim: runtime.config.tenantClaim,
              tenantMap: runtime.config.tenantMap,
            },
          }
        : {}),
      sessionSecret: getSessionSecret(),
      sessionTtlMs: SESSION_TTL_MS,
      fetchFn: fetch,
      nowMs: () => Date.now(),
    },
    {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      transientCookie: request.cookies.get(TRANSIENT_COOKIE)?.value ?? null,
      redirectUri: new URL("/api/oidc/callback", request.url).toString(),
    },
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const response = NextResponse.redirect(new URL("/runs", request.url), 303);
  response.cookies.set(SESSION_COOKIE, result.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  response.cookies.delete(TRANSIENT_COOKIE);
  return response;
}
