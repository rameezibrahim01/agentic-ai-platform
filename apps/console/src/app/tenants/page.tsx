import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { operatorAccess, operatorOverview } from "../../lib/operator";
import type { KillSwitchState } from "../../lib/operator";
import { formatUsd } from "../../lib/viewmodels";
import { getAllTenantStores, isTenanted } from "../../lib/store";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

// The operator's limits view mirrors each LANE's resolution (ticket 037):
// limits.<id>.config.json beside the shared file when present, else shared.
async function limitsFor(tenantId: string): Promise<KillSwitchState | null> {
  const sharedPath = process.env["LIMITS_CONFIG"];
  if (!sharedPath) return null;
  const tenantPath = join(dirname(sharedPath), `limits.${tenantId}.config.json`);
  let raw: string;
  try {
    raw = await readFile(tenantPath, "utf8");
  } catch {
    try {
      raw = await readFile(sharedPath, "utf8");
    } catch {
      return null;
    }
  }
  const parsed = JSON.parse(raw) as {
    killSwitches?: { global?: boolean; agents?: Record<string, boolean> };
  };
  return {
    global: parsed.killSwitches?.global === true,
    trippedAgents: Object.entries(parsed.killSwitches?.agents ?? {})
      .filter(([, tripped]) => tripped)
      .map(([agent]) => agent),
  };
}

// Cross-tenant HEALTH for the platform operator (ticket 042) — metadata
// only. There are deliberately no links into other tenants' runs: run
// contents stay session-tenant-scoped (038), and per-tenant keys mean this
// console may not even be able to decrypt them.
export default async function TenantsPage() {
  const session = await requireSession();
  const access = operatorAccess(session, isTenanted());
  if (!access.allowed) {
    return (
      <main>
        <p>
          {access.reason === "not_tenanted"
            ? "this deployment is not tenanted — there is one lane; see runs."
            : access.reason === "forbidden"
              ? "the operator view requires the platform_admin role."
              : `your session is bound to tenant ${session.tenant} — the operator view is for untenanted platform identities.`}
        </p>
        <Link href="/runs">← runs</Link>
      </main>
    );
  }

  const rows = await operatorOverview(await getAllTenantStores(), limitsFor);
  return (
    <main>
      <h2 style={{ fontSize: 16 }}>
        tenants ({rows.length}) · platform operator view · <Link href="/limits">limits</Link>
      </h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>tenant</th>
            <th style={cell}>runs</th>
            <th style={cell}>by status</th>
            <th style={cell}>awaiting approval</th>
            <th style={cell}>cost</th>
            <th style={cell}>kill switch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={cell}>
                {row.displayName} ({row.id})
              </td>
              {row.runs === "unreadable" ? (
                <td style={{ ...cell, color: "#b00" }} colSpan={4}>
                  unreadable — this console holds no key for the tenant&apos;s store
                </td>
              ) : (
                <>
                  <td style={cell}>{row.runs.total}</td>
                  <td style={cell}>
                    {Object.entries(row.runs.byStatus)
                      .map(([status, count]) => `${status}: ${count}`)
                      .join(", ") || "—"}
                  </td>
                  <td style={cell}>{row.runs.awaitingApproval}</td>
                  <td style={cell}>{formatUsd(row.runs.costUsd)}</td>
                </>
              )}
              <td style={cell}>
                {row.killSwitch === "unconfigured" ? (
                  "unconfigured"
                ) : row.killSwitch.global ? (
                  <b style={{ color: "#b00" }}>GLOBAL TRIPPED</b>
                ) : row.killSwitch.trippedAgents.length > 0 ? (
                  <span style={{ color: "#b00" }}>
                    tripped: {row.killSwitch.trippedAgents.join(", ")}
                  </span>
                ) : (
                  "off"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "#666" }}>
        metadata only: the operator view never browses into a tenant&apos;s run contents —
        those stay bound to tenant sessions (and tenant keys).
      </p>
    </main>
  );
}
