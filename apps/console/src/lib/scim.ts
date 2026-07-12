import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import {
  SCIM_ERROR_SCHEMA_URN,
  SCIM_LIST_SCHEMA_URN,
  SCIM_USER_SCHEMA_URN,
  scimPatchActive,
  scimPatchSchema,
  scimToAccount,
  scimUserSchema,
} from "@platform/auth";
import type { ScimMappingContext } from "@platform/auth";
import { PostgresAccountStore } from "@platform/storage";
import type { AccountRecord, AccountStore } from "@platform/storage";
import { getOidcRuntime } from "./oidc";
import { isTenanted } from "./store";

// SCIM 2.0 endpoints' decision logic (ticket 040), pure over injected deps —
// the routes are thin adapters. The IdP owns the lifecycle: create,
// deactivate (DELETE and PATCH active=false), reactivate. Rows never delete;
// the record is authoritative at login (lib/oidc.ts).

export interface ScimDeps {
  store: AccountStore;
  mapping: ScimMappingContext;
  nowMs: () => number;
}

export interface ScimResponse {
  status: number;
  body?: unknown;
}

const scimError = (status: number, detail: string): ScimResponse => ({
  status,
  body: { schemas: [SCIM_ERROR_SCHEMA_URN], status: String(status), detail },
});

const toResource = (record: AccountRecord) => ({
  schemas: [SCIM_USER_SCHEMA_URN],
  id: record.username,
  userName: record.username,
  ...(record.externalId !== undefined ? { externalId: record.externalId } : {}),
  active: record.active,
  // read-back transparency for operators; SCIM clients ignore unknown attrs
  "urn:platform:roles": record.roles,
  ...(record.tenant !== undefined ? { "urn:platform:tenant": record.tenant } : {}),
});

/** Bearer check, constant-time. The token itself comes from an env var whose NAME is config. */
export function checkScimAuth(authorization: string | null, token: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function scimCreateUser(deps: ScimDeps, body: unknown): Promise<ScimResponse> {
  const parsed = scimUserSchema.safeParse(body);
  if (!parsed.success) {
    return scimError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const mapped = scimToAccount(parsed.data, deps.mapping);
  if (!mapped.ok) {
    return scimError(400, "no group value maps to a tenant — this deployment is tenanted and never guesses");
  }
  const { account } = mapped;
  // one IdP identity = one account: an externalId already bound to a
  // DIFFERENT username is a conflict, not a silent takeover
  if (account.externalId !== undefined) {
    const existing = await deps.store.getByExternalId(account.externalId);
    if (existing !== undefined && existing.username !== account.username) {
      return scimError(409, `externalId is already bound to ${existing.username}`);
    }
  }
  const existed = (await deps.store.get(account.username)) !== undefined;
  const result = await deps.store.upsert({ ...account, updatedAt: deps.nowMs() });
  if (!result.ok) return scimError(409, result.error);
  const stored = await deps.store.get(account.username);
  return { status: existed ? 200 : 201, body: toResource(stored!) };
}

export async function scimListUsers(deps: ScimDeps, filter: string | null): Promise<ScimResponse> {
  let records = await deps.store.list();
  if (filter !== null && filter !== "") {
    const match = /^userName eq "([^"]+)"$/i.exec(filter.trim());
    if (match === null) return scimError(400, 'only the filter userName eq "..." is supported');
    records = records.filter((r) => r.username === match[1]!.toLowerCase());
  }
  return {
    status: 200,
    body: {
      schemas: [SCIM_LIST_SCHEMA_URN],
      totalResults: records.length,
      startIndex: 1,
      itemsPerPage: records.length,
      Resources: records.map(toResource),
    },
  };
}

export async function scimGetUser(deps: ScimDeps, id: string): Promise<ScimResponse> {
  const record = await deps.store.get(id.toLowerCase());
  if (record === undefined) return scimError(404, `no user ${id}`);
  return { status: 200, body: toResource(record) };
}

export async function scimPatchUser(
  deps: ScimDeps,
  id: string,
  body: unknown,
): Promise<ScimResponse> {
  const parsed = scimPatchSchema.safeParse(body);
  if (!parsed.success) return scimError(400, "malformed PatchOp");
  const active = scimPatchActive(parsed.data);
  if (!active.ok) return scimError(400, active.error);
  const record = await deps.store.get(id.toLowerCase());
  if (record === undefined) return scimError(404, `no user ${id}`);
  const result = await deps.store.upsert({
    ...record,
    active: active.active,
    updatedAt: deps.nowMs(),
  });
  if (!result.ok) return scimError(409, result.error);
  const stored = await deps.store.get(record.username);
  return { status: 200, body: toResource(stored!) };
}

export async function scimDeleteUser(deps: ScimDeps, id: string): Promise<ScimResponse> {
  const result = await deps.store.deactivate(id.toLowerCase(), deps.nowMs());
  // DELETE = deactivate, never a row deletion — the provisioning history is audit data
  return result.ok ? { status: 204 } : scimError(404, `no user ${id}`);
}

// ---- runtime wiring (the routes' half) ----

export interface ScimRuntime {
  deps: ScimDeps;
  token: string;
}

let poolPromise: pg.Pool | null = null;
let storePromise: PostgresAccountStore | null = null;

/**
 * SCIM is ON when SCIM_TOKEN_ENV names a populated env var, OIDC_CONFIG is
 * mounted (its role/tenant maps ARE the provisioning maps — same IdP, same
 * config), and DATABASE_URL is set. A named-but-empty token is a loud
 * failure, never an open endpoint.
 */
export async function getScimRuntime(): Promise<ScimRuntime | null> {
  const tokenEnv = process.env["SCIM_TOKEN_ENV"];
  if (!tokenEnv) return null;
  const token = process.env[tokenEnv];
  if (!token) {
    throw new Error(`SCIM token env ${tokenEnv} is named but empty — refusing an open endpoint`);
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("SCIM requires DATABASE_URL (the account store is Postgres)");
  const runtime = await getOidcRuntime();
  if (runtime === null) {
    throw new Error("SCIM requires OIDC_CONFIG — its role/tenant maps are the provisioning maps");
  }
  poolPromise ??= new pg.Pool({ connectionString: databaseUrl });
  storePromise ??= new PostgresAccountStore(poolPromise);
  return {
    token,
    deps: {
      store: storePromise,
      mapping: {
        roles: {
          rolesClaim: runtime.config.rolesClaim,
          roleMap: runtime.config.roleMap,
          defaultRoles: runtime.config.defaultRoles,
        },
        ...(runtime.config.tenantMap !== undefined
          ? { tenantMap: runtime.config.tenantMap }
          : {}),
        tenanted: isTenanted(),
      },
      nowMs: () => Date.now(),
    },
  };
}

/** Login-path lookup (lib/oidc.ts): configured only when SCIM is on. */
export async function getAccountLookup(): Promise<
  ((externalId: string) => Promise<AccountRecord | undefined>) | null
> {
  const runtime = await getScimRuntime().catch(() => null);
  if (runtime === null) return null;
  return (externalId) => runtime.deps.store.getByExternalId(externalId);
}
