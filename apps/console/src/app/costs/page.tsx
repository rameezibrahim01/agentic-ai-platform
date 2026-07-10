import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { getStore } from "../../lib/store";
import { loadScores } from "../../lib/scores";
import { costsView, driftAlarms } from "../../lib/metrics";
import { formatUsd } from "../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

// Default thresholds for the deployed profile; a real deployment tunes these
// via review, not code (they are inputs to a pure function).
const THRESHOLDS = {
  maxToolFailureRate: 0.2,
  maxRefusalRate: 0.5,
  maxBudgetKillRate: 0.3,
  minMeanScore: 3,
};

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

export default async function CostsPage() {
  await requireSession();
  const rows = await costsView(await getStore(), await loadScores());
  const alarms = driftAlarms(rows, THRESHOLDS);
  return (
    <main>
      <h2 style={{ fontSize: 16 }}>
        cost per outcome · <Link href="/runs">runs</Link> ·{" "}
        <Link href="/approvals">approval inbox</Link>
      </h2>
      {alarms.length > 0 && (
        <ul>
          {alarms.map((alarm) => (
            <li key={`${alarm.agent}-${alarm.metric}`} style={{ color: "#b00" }}>
              DRIFT: {alarm.agent} {alarm.metric} = {alarm.value.toFixed(2)} (threshold{" "}
              {alarm.threshold})
            </li>
          ))}
        </ul>
      )}
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>agent</th>
            <th style={cell}>runs</th>
            <th style={cell}>completed</th>
            <th style={cell}>total cost</th>
            <th style={cell}>cost / outcome</th>
            <th style={cell}>judge score (sampled)</th>
            <th style={cell}>tool failures</th>
            <th style={cell}>refusals / run</th>
            <th style={cell}>budget kills</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agent}>
              <td style={cell}>{row.agent}</td>
              <td style={cell}>{row.runs}</td>
              <td style={cell}>{row.completed}</td>
              <td style={cell}>{formatUsd(row.totalCostUsd)}</td>
              <td style={cell}>
                {row.costPerOutcomeUsd === null ? "—" : formatUsd(row.costPerOutcomeUsd)}
              </td>
              <td style={cell}>{row.meanScore === null ? "unsampled" : row.meanScore.toFixed(2)}</td>
              <td style={cell}>{pct(row.toolFailureRate)}</td>
              <td style={cell}>{row.refusalRate.toFixed(2)}</td>
              <td style={cell}>{pct(row.budgetKillRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
