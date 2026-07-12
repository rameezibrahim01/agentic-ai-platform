import { z } from "zod";
import pg from "pg";
import {
  makeEncryptedEventCodec,
  migrate,
  PostgresEventStore,
  PostgresHoldStore,
  PostgresScoreStore,
} from "@platform/storage";
import type { EventStore, HoldStore, ScoreStore } from "@platform/storage";

// The tenant registry (ticket 036): tenants are CONFIGURATION — a mounted
// file names them, one Postgres schema each, per-tenant 035 data keys via
// named env vars (never key material in the file). A named-but-empty key
// env is a boot failure: silent plaintext for a tenant that asked for
// encryption is the one mistake this module exists to prevent.

export const tenantsConfigSchema = z
  .object({
    tenants: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "tenant id must be a slug"),
            displayName: z.string().min(1),
            /** Env var NAME holding this tenant's 64-hex data key. */
            dataKeyEnv: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type TenantsConfig = z.infer<typeof tenantsConfigSchema>;
export type TenantSpec = TenantsConfig["tenants"][number];

export type ParseTenantsResult =
  | { ok: true; config: TenantsConfig }
  | { ok: false; error: string };

export function parseTenantsConfig(raw: unknown): ParseTenantsResult {
  const parsed = tenantsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid tenants config: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const seen = new Set<string>();
  for (const tenant of parsed.data.tenants) {
    if (seen.has(tenant.id)) return { ok: false, error: `duplicate tenant id ${tenant.id}` };
    seen.add(tenant.id);
  }
  return { ok: true, config: parsed.data };
}

/** Tenant slug → Postgres schema name. */
export function schemaFor(tenantId: string): string {
  return `tenant_${tenantId.replaceAll("-", "_")}`;
}

export interface TenantStores {
  spec: TenantSpec;
  schema: string;
  store: EventStore;
  scores: ScoreStore;
  holds: HoldStore;
}

/**
 * Migrate each tenant's schema and construct its isolated stores. The
 * activities built on top of these can only ever write where they were
 * pointed — isolation by construction, not by filtering.
 */
export async function openTenantStores(
  pool: pg.Pool,
  config: TenantsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Map<string, TenantStores>> {
  const stores = new Map<string, TenantStores>();
  for (const spec of config.tenants) {
    let codec;
    if (spec.dataKeyEnv !== undefined) {
      const key = env[spec.dataKeyEnv];
      if (!key) {
        throw new Error(
          `tenant ${spec.id}: data key env ${spec.dataKeyEnv} is named but empty — refusing silent plaintext`,
        );
      }
      codec = makeEncryptedEventCodec(key);
    }
    const schema = schemaFor(spec.id);
    await migrate(pool, { schema });
    stores.set(spec.id, {
      spec,
      schema,
      store: new PostgresEventStore(pool, codec, schema),
      scores: new PostgresScoreStore(pool, schema),
      holds: new PostgresHoldStore(pool, schema),
    });
  }
  return stores;
}
