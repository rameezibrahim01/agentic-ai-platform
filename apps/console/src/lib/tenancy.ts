import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { EventStore } from "@platform/storage";

// Console tenancy (ticket 038). A session BINDS to one tenant at sign-in;
// every page and API resolves its store through that binding — there is no
// query-param or header override, so "developer in A sees B's runs" is
// impossible by construction. The decision logic here is pure over injected
// deps; lib/store.ts wires it to the real config.

// Same shape as the worker's TENANTS_CONFIG (apps/worker/src/tenants.ts) —
// the console validates its own copy of the mounted file rather than
// importing the worker package into the Next bundle (same reasoning as the
// signal-name string in lib/temporal.ts).
export const consoleTenantsSchema = z
  .object({
    tenants: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "tenant id must be a slug"),
            displayName: z.string().min(1),
            dataKeyEnv: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ConsoleTenantsConfig = z.infer<typeof consoleTenantsSchema>;
export type ConsoleTenantSpec = ConsoleTenantsConfig["tenants"][number];

export async function loadTenantsFile(path: string): Promise<ConsoleTenantsConfig> {
  const parsed = consoleTenantsSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `TENANTS_CONFIG rejected: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Tenant slug → Postgres schema name (matches the worker's schemaFor). */
export function schemaForTenant(tenantId: string): string {
  return `tenant_${tenantId.replaceAll("-", "_")}`;
}

/** Tenanted workflowIds are tenant-qualified (ticket 037's workflowIdFor). */
export function workflowIdFor(runId: string, tenant?: string): string {
  return tenant === undefined ? runId : `${tenant}--${runId}`;
}

/** Tenanted lanes poll their own queue (ticket 037's taskQueueFor). */
export function taskQueueFor(tenant?: string): string {
  return tenant === undefined ? "agent-runs" : `agent-runs--${tenant}`;
}

export interface StoreSelectionDeps {
  tenanted: boolean;
  /** The untenanted deployment's store — today's behavior, byte-identical. */
  untenanted(): Promise<EventStore>;
  /** One tenant's isolated store; null for a tenant that doesn't exist. */
  forTenant(tenantId: string): Promise<EventStore | null>;
}

/**
 * The one rule every console surface goes through: untenanted deployments
 * see the shared store; in a tenanted deployment a session sees exactly its
 * tenant's store — an unbound session (or an unknown tenant) sees NOTHING,
 * with a plain explanation at the page layer, never a default tenant.
 */
export function selectStore(
  deps: StoreSelectionDeps,
  tenant: string | undefined,
): Promise<EventStore | null> {
  if (!deps.tenanted) return deps.untenanted();
  if (tenant === undefined) return Promise.resolve(null);
  return deps.forTenant(tenant);
}

export interface ApprovalSignalDeps {
  tenanted: boolean;
  /** The SESSION tenant's store (already resolved via selectStore). */
  store: EventStore | null;
  signal(
    workflowId: string,
    decision: { granted: boolean; by: string; comment?: string },
  ): Promise<void>;
}

export type ApprovalSignalResult = "signaled" | "not_found";

/**
 * Approvals stay honest across tenants: the store lookup gates the signal,
 * so a session bound to tenant A cannot signal a run it cannot see — B's
 * runId is a 404 and NO signal leaves the console. Untenanted deployments
 * keep the pre-038 behavior exactly (signal by bare runId, no gate).
 */
export async function decideApprovalSignal(
  deps: ApprovalSignalDeps,
  params: {
    runId: string;
    tenant: string | undefined;
    decision: { granted: boolean; by: string; comment?: string };
  },
): Promise<ApprovalSignalResult> {
  if (!deps.tenanted) {
    await deps.signal(params.runId, params.decision);
    return "signaled";
  }
  if (deps.store === null) return "not_found";
  if ((await deps.store.load(params.runId)) === null) return "not_found";
  await deps.signal(workflowIdFor(params.runId, params.tenant), params.decision);
  return "signaled";
}

/**
 * The same store-lookup gate for OTHER run signals (ticket 050's
 * delegation): a session may signal only runs its tenant can see; the
 * payload rides in the injected closure. Untenanted stays bare-runId.
 */
export async function gateTenantRunSignal(
  deps: {
    tenanted: boolean;
    store: EventStore | null;
    signal(workflowId: string): Promise<void>;
  },
  params: { runId: string; tenant: string | undefined },
): Promise<ApprovalSignalResult> {
  if (!deps.tenanted) {
    await deps.signal(params.runId);
    return "signaled";
  }
  if (deps.store === null) return "not_found";
  if ((await deps.store.load(params.runId)) === null) return "not_found";
  await deps.signal(workflowIdFor(params.runId, params.tenant));
  return "signaled";
}
