import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  issueSessionFor,
  jwksSchema,
  mapOidcRoles,
  mapOidcTenant,
  oidcPrincipal,
  oidcRoleMappingSchema,
  verifyIdToken,
} from "@platform/auth";
import type { Jwks, OidcTenantMapping, Role } from "@platform/auth";

// OIDC federation (ticket 034): any spec-compliant, self-hostable issuer.
// Config is mounted (roles come from the map, never from the IdP alone);
// discovery + JWKS fetch once per boot; the callback issues the SAME 013
// session — one session mechanism, two front doors. All decision logic
// lives in handleOidcCallback, pure over injected deps.

export const oidcConfigSchema = z
  .object({
    issuer: z.string().url(),
    clientId: z.string().min(1),
    /** Name of the env var holding the client secret — never the secret itself. */
    clientSecretEnv: z.string().min(1),
    scopes: z.string().min(1).default("openid profile email"),
    /** Tenant binding (ticket 038): which claim carries the IdP org value. */
    tenantClaim: z.string().min(1).optional(),
    /** IdP value → tenant id. Unmapped in a tenanted deployment = refused login. */
    tenantMap: z.record(z.string().min(1)).optional(),
  })
  .merge(oidcRoleMappingSchema)
  .strict()
  .refine((c) => (c.tenantClaim === undefined) === (c.tenantMap === undefined), {
    message: "tenantClaim and tenantMap must be configured together",
  });

export type OidcConfig = z.infer<typeof oidcConfigSchema>;

export interface OidcRuntime {
  config: OidcConfig;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwks: Jwks;
}

const discoverySchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
  })
  .passthrough();

let runtimePromise: Promise<OidcRuntime | null> | null = null;

async function loadRuntime(): Promise<OidcRuntime | null> {
  const configPath = process.env["OIDC_CONFIG"];
  if (!configPath) return null; // no config → local accounts only, unchanged
  const parsed = oidcConfigSchema.safeParse(JSON.parse(await readFile(configPath, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `OIDC_CONFIG rejected: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const config = parsed.data;
  const clientSecret = process.env[config.clientSecretEnv];
  if (!clientSecret) throw new Error(`OIDC client secret env ${config.clientSecretEnv} is not set`);

  const discoveryResponse = await fetch(
    `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  if (!discoveryResponse.ok) {
    throw new Error(`OIDC discovery failed: HTTP ${discoveryResponse.status}`);
  }
  const discovery = discoverySchema.parse(await discoveryResponse.json());
  const jwksResponse = await fetch(discovery.jwks_uri);
  if (!jwksResponse.ok) throw new Error(`OIDC JWKS fetch failed: HTTP ${jwksResponse.status}`);
  const jwks = jwksSchema.parse(await jwksResponse.json());

  return {
    config,
    clientSecret,
    authorizationEndpoint: discovery.authorization_endpoint,
    tokenEndpoint: discovery.token_endpoint,
    jwks,
  };
}

export function getOidcRuntime(): Promise<OidcRuntime | null> {
  runtimePromise ??= loadRuntime();
  return runtimePromise;
}

// ---- transient state/nonce cookie (10 minutes, HMAC over the payload) ----

export const TRANSIENT_COOKIE = "platform_oidc_state";
export const TRANSIENT_TTL_MS = 10 * 60 * 1000;

export interface TransientClaims {
  state: string;
  nonce: string;
  exp: number;
}

const transientSchema = z
  .object({ state: z.string().min(1), nonce: z.string().min(1), exp: z.number().int() })
  .strict();

const hmac = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export function signTransient(claims: TransientClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${hmac(payload, secret)}`;
}

export function verifyTransient(
  value: string,
  secret: string,
  nowMs: number,
): TransientClaims | null {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = Buffer.from(hmac(parts[0], secret), "utf8");
  const presented = Buffer.from(parts[1], "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = transientSchema.safeParse(claims);
  if (!parsed.success || parsed.data.exp <= nowMs) return null;
  return parsed.data;
}

// ---- the callback, pure over injected deps ----

export interface CallbackDeps {
  issuer: string;
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  jwks: Jwks;
  mapping: { rolesClaim: string; roleMap: Record<string, Role[]>; defaultRoles: Role[] };
  /** Tenanted deployment (038): a login MUST resolve a tenant or be refused. */
  tenanted: boolean;
  tenantMapping?: OidcTenantMapping;
  sessionSecret: string;
  sessionTtlMs: number;
  fetchFn: typeof fetch;
  nowMs: () => number;
}

export interface CallbackParams {
  code: string | null;
  state: string | null;
  transientCookie: string | null;
  redirectUri: string;
}

export type CallbackResult =
  | { ok: true; sessionToken: string; principal: string; roles: Role[]; tenant?: string }
  | { ok: false; status: 400 | 401 | 502; error: string };

export async function handleOidcCallback(
  deps: CallbackDeps,
  params: CallbackParams,
): Promise<CallbackResult> {
  if (!params.code || !params.state) {
    return { ok: false, status: 400, error: "code and state are required" };
  }
  const transient = params.transientCookie
    ? verifyTransient(params.transientCookie, deps.sessionSecret, deps.nowMs())
    : null;
  if (transient === null || transient.state !== params.state) {
    return { ok: false, status: 401, error: "state mismatch or expired login attempt" };
  }

  const tokenResponse = await deps.fetchFn(deps.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
    }).toString(),
  });
  if (!tokenResponse.ok) {
    return { ok: false, status: 502, error: `token exchange failed: HTTP ${tokenResponse.status}` };
  }
  const tokenBody = (await tokenResponse.json()) as { id_token?: string };
  if (typeof tokenBody.id_token !== "string") {
    return { ok: false, status: 502, error: "token endpoint returned no id_token" };
  }

  const verified = verifyIdToken(tokenBody.id_token, {
    issuer: deps.issuer,
    audience: deps.clientId,
    jwks: deps.jwks,
    nowMs: deps.nowMs(),
    nonce: transient.nonce,
  });
  if (!verified.ok) {
    return { ok: false, status: 401, error: `id token rejected: ${verified.reason}` };
  }

  const roles = mapOidcRoles(verified.claims, deps.mapping);
  const principal = oidcPrincipal(verified.claims);

  // Tenant binding (038): the tenant comes from the config map alone, and a
  // tenanted deployment NEVER guesses — unmapped (or unconfigured) is a
  // refused login, not a default workspace.
  let tenant: string | undefined;
  if (deps.tenantMapping !== undefined) {
    const mapped = mapOidcTenant(verified.claims, deps.tenantMapping);
    if (mapped.ok) {
      tenant = mapped.tenant;
    } else if (deps.tenanted) {
      return { ok: false, status: 401, error: `tenant mapping refused: ${mapped.reason}` };
    }
  } else if (deps.tenanted) {
    return {
      ok: false,
      status: 401,
      error: "tenanted deployment with no OIDC tenant mapping — refusing login",
    };
  }

  const sessionToken = issueSessionFor(
    verified.claims.sub,
    principal,
    roles,
    deps.sessionTtlMs,
    deps.sessionSecret,
    deps.nowMs(),
    tenant,
  );
  return { ok: true, sessionToken, principal, roles, ...(tenant !== undefined ? { tenant } : {}) };
}
