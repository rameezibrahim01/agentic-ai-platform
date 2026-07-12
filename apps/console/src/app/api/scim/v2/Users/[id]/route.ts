import { NextResponse, type NextRequest } from "next/server";
import { scimDeleteUser, scimGetUser, scimPatchUser } from "../../../../../../lib/scim";
import { scimGuard, scimRespond } from "../../../../../../lib/scim-http";

// SCIM 2.0 single-User resource (ticket 040). DELETE deactivates — rows are
// never deleted; the provisioning history is audit data.

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const guarded = await scimGuard(request);
  if ("response" in guarded) return guarded.response;
  const { id } = await params;
  return scimRespond(await scimGetUser(guarded.runtime.deps, decodeURIComponent(id)));
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const guarded = await scimGuard(request);
  if ("response" in guarded) return guarded.response;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  return scimRespond(await scimPatchUser(guarded.runtime.deps, decodeURIComponent(id), body));
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const guarded = await scimGuard(request);
  if ("response" in guarded) return guarded.response;
  const { id } = await params;
  return scimRespond(await scimDeleteUser(guarded.runtime.deps, decodeURIComponent(id)));
}
