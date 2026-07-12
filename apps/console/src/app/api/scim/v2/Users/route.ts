import { NextResponse, type NextRequest } from "next/server";
import { scimCreateUser, scimListUsers } from "../../../../../lib/scim";
import { scimGuard, scimRespond } from "../../../../../lib/scim-http";

// SCIM 2.0 Users collection (ticket 040). Thin adapter: auth + parse here,
// every decision in lib/scim.ts. Feature-off (no SCIM_TOKEN_ENV) = 404.

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guarded = await scimGuard(request);
  if ("response" in guarded) return guarded.response;
  const filter = new URL(request.url).searchParams.get("filter");
  return scimRespond(await scimListUsers(guarded.runtime.deps, filter));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await scimGuard(request);
  if ("response" in guarded) return guarded.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  return scimRespond(await scimCreateUser(guarded.runtime.deps, body));
}
