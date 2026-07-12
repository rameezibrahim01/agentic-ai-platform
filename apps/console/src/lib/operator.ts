import type { EventStore } from "@platform/storage";
import type { SessionClaims } from "@platform/auth";
import { can } from "@platform/auth";

// Platform-operator view (ticket 042): cross-tenant HEALTH, deliberately not
// cross-tenant browsing. The overview reads per-tenant metadata (counts,
// statuses, cost, switch states); run CONTENTS stay session-tenant-scoped
// exactly as 038 built them — per-tenant keys mean the console may not even
// be able to decrypt another tenant's rows, and "unreadable" is reported
// honestly, never as zero.

export type OperatorAccess =
  | { allowed: true }
  | { allowed: false; reason: "not_tenanted" | "forbidden" | "tenant_bound" };

/** Operator = an UNTENANTED platform_admin in a tenanted deployment. A
 * tenant-bound admin manages their tenant, not the platform. */
export function operatorAccess(
  session: Pick<SessionClaims, "roles" | "tenant">,
  tenanted: boolean,
): OperatorAccess {
  if (!tenanted) return { allowed: false, reason: "not_tenanted" };
  if (!can(session.roles, "manage_platform")) return { allowed: false, reason: "forbidden" };
  if (session.tenant !== undefined) return { allowed: false, reason: "tenant_bound" };
  return { allowed: true };
}

export interface TenantRuns {
  total: number;
  byStatus: Record<string, number>;
  awaitingApproval: number;
  costUsd: number;
}

export interface KillSwitchState {
  global: boolean;
  trippedAgents: string[];
}

export interface TenantHealthRow {
  id: string;
  displayName: string;
  runs: TenantRuns | "unreadable";
  killSwitch: KillSwitchState | "unconfigured";
}

export interface OverviewTenant {
  id: string;
  displayName: string;
  /** null = the console cannot open this tenant's store (e.g. key not mounted). */
  store: EventStore | null;
}

export async function operatorOverview(
  tenants: readonly OverviewTenant[],
  limitsFor: (tenantId: string) => Promise<KillSwitchState | null>,
): Promise<TenantHealthRow[]> {
  const rows: TenantHealthRow[] = [];
  for (const tenant of tenants) {
    let runs: TenantRuns | "unreadable" = "unreadable";
    if (tenant.store !== null) {
      try {
        const summaries = await tenant.store.listRuns();
        const byStatus: Record<string, number> = {};
        let costUsd = 0;
        for (const summary of summaries) {
          byStatus[summary.status] = (byStatus[summary.status] ?? 0) + 1;
          costUsd += summary.costUsd;
        }
        runs = {
          total: summaries.length,
          byStatus,
          awaitingApproval: byStatus["awaiting_approval"] ?? 0,
          costUsd,
        };
      } catch {
        // wrong/missing key, corrupt log — honesty over a fake zero
        runs = "unreadable";
      }
    }
    const killSwitch = await limitsFor(tenant.id);
    rows.push({
      id: tenant.id,
      displayName: tenant.displayName,
      runs,
      killSwitch: killSwitch ?? "unconfigured",
    });
  }
  return rows;
}
