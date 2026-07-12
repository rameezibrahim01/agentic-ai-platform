import pg from "pg";
import {
  InMemoryEventStore,
  makeEncryptedEventCodec,
  PostgresEventStore,
} from "@platform/storage";
import type { EventStore } from "@platform/storage";
import { loadTenantsFile, schemaForTenant, selectStore } from "./tenancy";
import type { ConsoleTenantSpec } from "./tenancy";
import { seedDemoRuns } from "./seed";

// Store selection via env (ticket 009): DATABASE_URL → Postgres (ticket 006),
// else an in-memory store seeded with demo runs so the pages render truthful
// data out of the box. With PLATFORM_DATA_KEY set (ticket 035) the console
// reads through the same encrypting codec as the worker; without the key,
// encrypted rows are honestly absent/unreadable — never garbage.
//
// Tenanted deployments (ticket 038): TENANTS_CONFIG mounted → getStore(tenant)
// opens THAT tenant's schema with THAT tenant's key. Pages pass the SESSION's
// tenant — never a query param — so cross-tenant reads have no code path.

let untenantedPromise: Promise<EventStore> | null = null;
let poolPromise: pg.Pool | null = null;
let tenantsPromise: Promise<Map<string, ConsoleTenantSpec>> | null = null;
const tenantStores = new Map<string, EventStore>();

function getPool(): pg.Pool {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("TENANTS_CONFIG requires DATABASE_URL — tenant stores are Postgres schemas");
  }
  poolPromise ??= new pg.Pool({ connectionString: url });
  return poolPromise;
}

async function initUntenanted(): Promise<EventStore> {
  const url = process.env["DATABASE_URL"];
  if (url) {
    const dataKey = process.env["PLATFORM_DATA_KEY"];
    // read-only viewer: connect without migrating — migrations are owned by
    // the worker/ops (ticket 006), never by a viewer
    return new PostgresEventStore(
      new pg.Pool({ connectionString: url }),
      dataKey ? makeEncryptedEventCodec(dataKey) : undefined,
    );
  }
  const store = new InMemoryEventStore();
  await seedDemoRuns(store);
  return store;
}

function getTenants(): Promise<Map<string, ConsoleTenantSpec>> {
  tenantsPromise ??= (async () => {
    const path = process.env["TENANTS_CONFIG"]!;
    const config = await loadTenantsFile(path);
    return new Map(config.tenants.map((t) => [t.id, t]));
  })();
  return tenantsPromise;
}

export function isTenanted(): boolean {
  return Boolean(process.env["TENANTS_CONFIG"]);
}

/** Display name for the header badge; null when unknown/untenanted. */
export async function tenantDisplayName(tenant: string | undefined): Promise<string | null> {
  if (!isTenanted() || tenant === undefined) return null;
  return (await getTenants()).get(tenant)?.displayName ?? null;
}

/**
 * The session's store. Untenanted deployments ignore the argument and behave
 * exactly as before 038. Tenanted deployments return the tenant's isolated
 * store — or null for an unbound session or unknown tenant, which pages
 * render as a plain explanation, never a default tenant's data.
 */
export function getStore(tenant?: string): Promise<EventStore | null> {
  return selectStore(
    {
      tenanted: isTenanted(),
      untenanted: () => {
        untenantedPromise ??= initUntenanted();
        return untenantedPromise;
      },
      forTenant: async (tenantId) => {
        const spec = (await getTenants()).get(tenantId);
        if (spec === undefined) return null;
        const cached = tenantStores.get(tenantId);
        if (cached) return cached;
        // the tenant's key comes from ITS named env var (036); a named-but-
        // empty env is a loud failure, never a silent plaintext read
        let codec;
        if (spec.dataKeyEnv !== undefined) {
          const key = process.env[spec.dataKeyEnv];
          if (!key) {
            throw new Error(
              `tenant ${tenantId}: data key env ${spec.dataKeyEnv} is named but empty`,
            );
          }
          codec = makeEncryptedEventCodec(key);
        }
        const store = new PostgresEventStore(getPool(), codec, schemaForTenant(tenantId));
        tenantStores.set(tenantId, store);
        return store;
      },
    },
    tenant,
  );
}
