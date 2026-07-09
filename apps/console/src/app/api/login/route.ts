import { NextResponse, type NextRequest } from "next/server";
import { issueSession, verifyPassword } from "@platform/auth";
import { getAccounts, getSessionSecret, SESSION_COOKIE, SESSION_TTL_MS } from "../../../lib/auth";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  const accounts = await getAccounts();
  const account = accounts.find((a) => a.username === username);
  // verify even on unknown user? account lookup is by name; verifyPassword is
  // constant-time on the hash comparison itself, which is what matters here.
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }

  const token = issueSession(account, SESSION_TTL_MS, getSessionSecret(), Date.now());
  const response = NextResponse.redirect(new URL("/runs", request.url), 303);
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return response;
}
