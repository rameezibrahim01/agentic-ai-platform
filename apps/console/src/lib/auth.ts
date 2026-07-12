import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  hashPassword,
  parseAccountsFile,
  verifySession,
  type Account,
  type SessionClaims,
} from "@platform/auth";

export const SESSION_COOKIE = "platform_session";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

// Accounts come from AUTH_ACCOUNTS_FILE (zod-validated JSON of scrypt hashes —
// a mounted secret/seed, never committed credentials). With no file configured
// a CLEARLY-MARKED dev fallback account is synthesized at boot; its hash is
// computed in memory, so no credential material ever lives in the repo.
let accountsPromise: Promise<Account[]> | null = null;

async function loadAccounts(): Promise<Account[]> {
  const file = process.env["AUTH_ACCOUNTS_FILE"];
  if (file) {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    const parsed = parseAccountsFile(raw);
    if (!parsed.ok) {
      throw new Error(`AUTH_ACCOUNTS_FILE is invalid: ${JSON.stringify(parsed.issues)}`);
    }
    return parsed.accounts;
  }
  const devPassword = process.env["AUTH_DEV_PASSWORD"] ?? "dev-password";
  console.warn(
    "auth: no AUTH_ACCOUNTS_FILE configured — using the DEV fallback account " +
      `("dev-admin"). Do not run a real deployment like this.`,
  );
  // AUTH_DEV_TENANT (ticket 039): tenant-bind the dev fallback so the
  // onboarding drill can exercise session scoping; real deployments bind
  // tenants via the accounts file or the OIDC tenant map (ticket 038).
  const devTenant = process.env["AUTH_DEV_TENANT"];
  return [
    {
      username: "dev-admin",
      passwordHash: hashPassword(devPassword),
      roles: ["platform_admin"],
      ...(devTenant ? { tenant: devTenant } : {}),
    },
  ];
}

export function getAccounts(): Promise<Account[]> {
  accountsPromise ??= loadAccounts();
  return accountsPromise;
}

// Secret from env; dev fallback is random per boot (sessions reset on restart).
let devSecret: string | null = null;
export function getSessionSecret(): string {
  const configured = process.env["AUTH_SESSION_SECRET"];
  if (configured) return configured;
  devSecret ??= randomBytes(32).toString("hex");
  return devSecret;
}

export async function currentSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const verified = verifySession(token, getSessionSecret(), Date.now());
  return verified.ok ? verified.claims : null;
}

/** Server-component guard: cryptographic check, not just cookie presence. */
export async function requireSession(): Promise<SessionClaims> {
  const session = await currentSession();
  if (session === null) redirect("/login");
  return session;
}
