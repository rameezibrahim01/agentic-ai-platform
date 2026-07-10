import Link from "next/link";
import { can } from "@platform/auth";
import { requireSession } from "../../lib/auth";
import { groupChangesets } from "../../lib/changesets";
import { intentPreview } from "../../lib/preview";
import { withSla, type SlaRow } from "../../lib/sla";
import { getStore } from "../../lib/store";
import { formatUtc, pendingApprovalsView } from "../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = {
  border: "1px solid #ccc",
  padding: "4px 8px",
  textAlign: "left",
  verticalAlign: "top",
};

const SLA_LABEL: Record<SlaRow["sla"], string> = {
  ok: "ok",
  expiring_soon: "expiring soon",
  expired_pending_deny: "expired — pending deny",
};

// Field-level preview of what the intent will change (ticket 025): values
// are JSON-escaped strings rendered as text nodes — argument content is
// data, never markup (CLAUDE.md #6).
function Preview({ row }: { row: SlaRow }) {
  const preview = intentPreview(row);
  return (
    <table style={{ borderCollapse: "collapse" }}>
      <tbody>
        {preview.rows.map((r) => (
          <tr key={r.field}>
            <td style={{ padding: "0 8px 0 0", color: "#555" }}>{r.field}</td>
            <td>
              <code style={{ whiteSpace: "pre-wrap" }}>{r.value}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Approve and deny share the same comment affordance: a deny without a
// legible reason is an audit hole (ticket 025).
function DecisionForm({ action, extra }: { action: string; extra?: React.ReactNode }) {
  return (
    <form action={action} method="post">
      {extra}
      <input name="comment" placeholder="reason / comment" />{" "}
      <button type="submit" name="decision" value="approve">
        approve
      </button>{" "}
      <button type="submit" name="decision" value="deny">
        deny
      </button>
    </form>
  );
}

// The approval inbox (architecture §8, deepened by ticket 025): full intent
// previews, SLA state from the log's own expiry (expiry = deny, so silence
// has a cost), soonest-to-expire first, and changeset approval for
// read/write tiers only — irreversible/financial stay one-by-one by
// construction.
export default async function ApprovalsPage() {
  const session = await requireSession();
  const canApprove = can(session.roles, "approve_intents");
  const rows = withSla(await pendingApprovalsView(await getStore()), Date.now());
  const { changesets, singles } = groupChangesets(rows);

  return (
    <main>
      <p>
        signed in as <b>{session.principal}</b> ({session.roles.join(", ")}) ·{" "}
        <Link href="/runs">runs</Link>
      </p>
      <h2 style={{ fontSize: 16 }}>
        approval inbox ({rows.length} pending{canApprove ? "" : " — read-only for your roles"})
      </h2>

      {changesets.length > 0 ? (
        <section>
          <h3 style={{ fontSize: 14 }}>changesets (same agent, tool, and tier — low-risk only)</h3>
          {changesets.map((changeset) => (
            <div
              key={changeset.key}
              style={{ border: "1px solid #ccc", padding: 8, marginBottom: 8 }}
            >
              <p style={{ margin: "0 0 4px" }}>
                <b>{changeset.tool}</b> [{changeset.risk}] by {changeset.agent} —{" "}
                {changeset.runs.length} runs
              </p>
              <ul style={{ margin: "0 0 4px" }}>
                {changeset.runs.map((run) => (
                  <li key={run.runId}>
                    <Link href={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</Link> (on
                    behalf of {run.principal}, expires {formatUtc(run.expiresAt)} —{" "}
                    {SLA_LABEL[run.sla]})
                  </li>
                ))}
              </ul>
              {canApprove ? (
                <DecisionForm
                  action="/api/approvals/batch"
                  extra={
                    <input
                      type="hidden"
                      name="runIds"
                      value={changeset.runs.map((run) => run.runId).join(",")}
                    />
                  }
                />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>run</th>
            <th style={cell}>agent</th>
            <th style={cell}>on behalf of</th>
            <th style={cell}>wants to</th>
            <th style={cell}>risk</th>
            <th style={cell}>what will change</th>
            <th style={cell}>requested (UTC)</th>
            <th style={cell}>expires (UTC)</th>
            <th style={cell}>sla</th>
            {canApprove ? <th style={cell}>decision</th> : null}
          </tr>
        </thead>
        <tbody>
          {singles.map((row) => (
            <tr key={row.runId}>
              <td style={cell}>
                <Link href={`/runs/${encodeURIComponent(row.runId)}`}>{row.runId}</Link>
              </td>
              <td style={cell}>{row.agent}</td>
              <td style={cell}>{row.principal}</td>
              <td style={cell}>{row.tool}</td>
              <td style={cell}>
                <b>{row.risk}</b>
              </td>
              <td style={cell}>
                <Preview row={row} />
              </td>
              <td style={cell}>{formatUtc(row.requestedAt)}</td>
              <td style={cell}>{formatUtc(row.expiresAt)}</td>
              <td style={cell}>{SLA_LABEL[row.sla]}</td>
              {canApprove ? (
                <td style={cell}>
                  <DecisionForm action={`/api/approvals/${encodeURIComponent(row.runId)}`} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
