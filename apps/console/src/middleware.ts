import { NextResponse, type NextRequest } from "next/server";

// Edge-safe first gate: cookie PRESENCE only (no crypto in the edge runtime).
// The cryptographic verification happens in the server components via
// requireSession() — a forged cookie passes this gate and is rejected there.
export function middleware(request: NextRequest) {
  if (!request.cookies.get("platform_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/runs", "/runs/:path*", "/approvals", "/approvals/:path*"],
};
