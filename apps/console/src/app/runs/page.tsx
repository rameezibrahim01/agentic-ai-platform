import Link from "next/link";
import { getStore } from "../../lib/store";
import { formatUsd, formatUtc, runListView } from "../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

export default async function RunsPage() {
  const rows = await runListView(await getStore());
  return (
    <main>
      <h2 style={{ fontSize: 16 }}>runs ({rows.length})</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>run id</th>
            <th style={cell}>status</th>
            <th style={cell}>steps</th>
            <th style={cell}>tokens in</th>
            <th style={cell}>tokens out</th>
            <th style={cell}>cost</th>
            <th style={cell}>started (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.runId}>
              <td style={cell}>
                <Link href={`/runs/${encodeURIComponent(row.runId)}`}>{row.runId}</Link>
              </td>
              <td style={cell}>{row.status}</td>
              <td style={cell}>{row.steps}</td>
              <td style={cell}>{row.tokensIn}</td>
              <td style={cell}>{row.tokensOut}</td>
              <td style={cell}>{formatUsd(row.costUsd)}</td>
              <td style={cell}>{formatUtc(row.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
