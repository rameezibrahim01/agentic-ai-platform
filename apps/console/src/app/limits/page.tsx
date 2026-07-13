import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { switchWriteTarget } from "../../lib/switches";
import { isTenanted } from "../../lib/store";

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

function FlipButton({
  scope,
  agent,
  tripped,
}: {
  scope: "global" | "agent";
  agent?: string;
  tripped: boolean;
}) {
  return (
    <form action="/api/limits/switch" method="post" style={{ display: "inline" }}>
      <input type="hidden" name="scope" value={scope} />
      {agent !== undefined ? <input type="hidden" name="agent" value={agent} /> : null}
      <input type="hidden" name="tripped" value={tripped ? "false" : "true"} />
      <button type="submit">{tripped ? "clear" : "TRIP"}</button>
    </form>
  );
}

export default async function LimitsPage() {
  const session = await requireSession();
  const { configured, view } = await loadLimitsView(session.tenant);
  // the flip write path (047): shown only to sessions the target resolution
  // admits — the POST re-checks everything server-side either way
  const canFlip = switchWriteTarget(session, isTenanted(), undefined).ok;
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
            </b>{" "}
            {canFlip ? <FlipButton scope="global" tripped={view.global} /> : null}
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
                      {tripped ? "TRIPPED" : "off"}{" "}
                      {canFlip ? <FlipButton scope="agent" agent={agent} tripped={tripped} /> : null}
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
          {canFlip ? (
            <form action="/api/limits/switch" method="post">
              <input type="hidden" name="scope" value="agent" />
              <input type="hidden" name="tripped" value="true" />
              <input name="agent" placeholder="agent@vN to trip" />{" "}
              <button type="submit">TRIP agent</button>
            </form>
          ) : null}
          <p style={{ color: "#666" }}>
            two write paths, same file: the buttons above (audited in ops_audit, ticket 047) or
            editing the mounted limits.config.json directly; the worker re-reads it on every
            check (no restart).
          </p>
        </>
      )}
    </main>
  );
}
