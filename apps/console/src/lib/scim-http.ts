import { NextResponse, type NextRequest } from "next/server";
import { checkScimAuth, getScimRuntime } from "./scim";
import type { ScimRuntime } from "./scim";

// Shared HTTP half of the SCIM adapters (ticket 040) — route files may only
// export HTTP methods, so the guard/respond helpers live here.

const SCIM_CONTENT_TYPE = "application/scim+json";

export async function scimGuard(
  request: NextRequest,
): Promise<{ runtime: ScimRuntime } | { response: NextResponse }> {
  const runtime = await getScimRuntime();
  if (runtime === null) {
    return { response: NextResponse.json({ error: "SCIM is not configured" }, { status: 404 }) };
  }
  if (!checkScimAuth(request.headers.get("authorization"), runtime.token)) {
    return {
      response: new NextResponse(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      }),
    };
  }
  return { runtime };
}

export function scimRespond(result: { status: number; body?: unknown }): NextResponse {
  return result.body === undefined
    ? new NextResponse(null, { status: result.status })
    : NextResponse.json(result.body, {
        status: result.status,
        headers: { "content-type": SCIM_CONTENT_TYPE },
      });
}
