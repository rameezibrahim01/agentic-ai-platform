import Link from "next/link";
import { can } from "@platform/auth";
import { requireSession } from "../../../lib/auth";
import { getStore } from "../../../lib/store";
import { baseName } from "../../../lib/agents";
import { formatUsd, formatUtc, runTimelineView } from "../../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

export default async function RunTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { runId } = await params;
  const { error } = await searchParams;
  const store = await getStore(session.tenant);
  if (store === null) {
    return (
      <main>
        <p>
          this deployment is tenanted and your session is not bound to a tenant — there is
          nothing to show.
        </p>
        <Link href="/runs">← all runs</Link>
      </main>
    );
  }
  const timeline = await runTimelineView(store, decodeURIComponent(runId));

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

  const cancellable =
    (timeline.status === "running" || timeline.status === "awaiting_approval") &&
    can(session.roles, "manage_platform");

  return (
    <main>
      <h2 style={{ fontSize: 16 }}>run {timeline.runId}</h2>
      {error !== undefined && <p style={{ color: "#b00" }}>{error}</p>}
      <p>
        status: <b>{timeline.status}</b> · outcome: {timeline.outcome} · agent:{" "}
        <Link href={`/agents/${encodeURIComponent(baseName(timeline.agent))}`}>
          {timeline.agent}
        </Link>{" "}
        ·
        principal: {timeline.principal} · started: {formatUtc(timeline.startedAt)}
      </p>
      <p>
        totals — steps: {timeline.totals.steps} · tokens: {timeline.totals.tokensIn} in /{" "}
        {timeline.totals.tokensOut} out · cost: {formatUsd(timeline.totals.costUsd)}
      </p>
      {cancellable && (
        <form
          method="post"
          action={`/api/runs/${encodeURIComponent(timeline.runId)}/cancel`}
          style={{ marginBottom: 8 }}
        >
          <button type="submit">cancel run</button>{" "}
          <span style={{ color: "#666" }}>
            stops at the next step, audited; a run awaiting approval ends when the approval is
            decided
          </span>
        </form>
      )}
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
