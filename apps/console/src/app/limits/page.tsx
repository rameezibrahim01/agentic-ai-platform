import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Link from "next/link";
import { requireSession } from "../../lib/auth";

export const dynamic = "force-dynamic";

// Read-only limits surface (ticket 033): the console SHOWS the operator
// levers; flipping them stays a config edit — an ops action with file-level
// audit, not a web click, until write-path auth is designed (new issue).

interface LimitsView {
  global: boolean;
  agents: [string, boolean][];
  caps?: Record<string, number>;
  runsPerHourPerAgent?: number;
}

async function loadLimitsView(
  tenant?: string,
): Promise<{ configured: boolean; source?: string; view?: LimitsView }> {
  const sharedPath = process.env["LIMITS_CONFIG"];
  if (!sharedPath) return { configured: false };
  // tenanted sessions (038) see THEIR lane's limits: limits.<id>.config.json
  // beside the shared file when present, else the shared file — the same
  // resolution the worker's lane uses (ticket 037)
  let path = sharedPath;
  if (tenant !== undefined) {
    const tenantPath = join(dirname(sharedPath), `limits.${tenant}.config.json`);
    try {
      await readFile(tenantPath);
      path = tenantPath;
    } catch {
      // no tenant override — the shared file governs this lane
    }
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    killSwitches?: { global?: boolean; agents?: Record<string, boolean> };
    budgetCaps?: Record<string, number>;
    rateLimits?: { runsPerHourPerAgent?: number };
  };
  return {
    configured: true,
    view: {
      global: raw.killSwitches?.global === true,
      agents: Object.entries(raw.killSwitches?.agents ?? {}),
      ...(raw.budgetCaps !== undefined ? { caps: raw.budgetCaps } : {}),
      ...(raw.rateLimits?.runsPerHourPerAgent !== undefined
        ? { runsPerHourPerAgent: raw.rateLimits.runsPerHourPerAgent }
        : {}),
    },
  };
}

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

export default async function LimitsPage() {
  const session = await requireSession();
  const { configured, view } = await loadLimitsView(session.tenant);
  return (
    <main>
      <h2 style={{ fontSize: 16 }}>
        operator limits · <Link href="/runs">runs</Link> · <Link href="/costs">costs</Link>
      </h2>
      {!configured || !view ? (
        <p>no LIMITS_CONFIG mounted — no switches, caps, or rate limits are active.</p>
      ) : (
        <>
          <p>
            global kill switch:{" "}
            <b style={{ color: view.global ? "#b00" : "inherit" }}>
              {view.global ? "TRIPPED — all runs halt at their next step" : "off"}
            </b>
          </p>
          <table style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={cell}>agent switch</th>
                <th style={cell}>state</th>
              </tr>
            </thead>
            <tbody>
              {view.agents.length === 0 ? (
                <tr>
                  <td style={cell} colSpan={2}>
                    no per-agent switches configured
                  </td>
                </tr>
              ) : (
                view.agents.map(([agent, tripped]) => (
                  <tr key={agent}>
                    <td style={cell}>{agent}</td>
                    <td style={{ ...cell, color: tripped ? "#b00" : "inherit" }}>
                      {tripped ? "TRIPPED" : "off"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p>
            budget caps: {view.caps ? JSON.stringify(view.caps) : "none"} · rate limit:{" "}
            {view.runsPerHourPerAgent !== undefined
              ? `${view.runsPerHourPerAgent} runs/hour/agent`
              : "none"}
          </p>
          <p style={{ color: "#666" }}>
            flipping a switch = editing the mounted limits.config.json; the worker re-reads it on
            every check (no restart).
          </p>
        </>
      )}
    </main>
  );
}
