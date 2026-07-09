import Link from "next/link";
import { getStore } from "../../../lib/store";
import { formatUsd, formatUtc, runTimelineView } from "../../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

export default async function RunTimelinePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const timeline = await runTimelineView(await getStore(), decodeURIComponent(runId));

  if (!timeline.ok) {
    return (
      <main>
        <p>
          {timeline.error.code === "not_found"
            ? `run not found: ${decodeURIComponent(runId)}`
            : `event log is unreplayable: ${JSON.stringify(timeline.error.reason)}`}
        </p>
        <Link href="/runs">← all runs</Link>
      </main>
    );
  }

  return (
    <main>
      <h2 style={{ fontSize: 16 }}>run {timeline.runId}</h2>
      <p>
        status: <b>{timeline.status}</b> · outcome: {timeline.outcome} · agent: {timeline.agent} ·
        principal: {timeline.principal} · started: {formatUtc(timeline.startedAt)}
      </p>
      <p>
        totals — steps: {timeline.totals.steps} · tokens: {timeline.totals.tokensIn} in /{" "}
        {timeline.totals.tokensOut} out · cost: {formatUsd(timeline.totals.costUsd)}
      </p>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>seq</th>
            <th style={cell}>at (UTC)</th>
            <th style={cell}>event</th>
            <th style={cell}>summary</th>
            <th style={cell}>tokens</th>
            <th style={cell}>cost</th>
            <th style={cell}>running cost</th>
          </tr>
        </thead>
        <tbody>
          {timeline.rows.map((row) => (
            <tr key={row.seq}>
              <td style={cell}>{row.seq}</td>
              <td style={cell}>{formatUtc(row.at)}</td>
              <td style={cell}>{row.type}</td>
              <td style={cell}>{row.summary}</td>
              <td style={cell}>
                {row.tokensIn !== undefined ? `${row.tokensIn} / ${row.tokensOut}` : ""}
              </td>
              <td style={cell}>{row.costUsd !== undefined ? formatUsd(row.costUsd) : ""}</td>
              <td style={cell}>{formatUsd(row.runningCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <Link href="/runs">← all runs</Link>
      </p>
    </main>
  );
}
