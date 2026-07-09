import Link from "next/link";
import { can } from "@platform/auth";
import { requireSession } from "../../lib/auth";
import { getStore } from "../../lib/store";
import { formatUtc, pendingApprovalsView } from "../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = {
  border: "1px solid #ccc",
  padding: "4px 8px",
  textAlign: "left",
  verticalAlign: "top",
};

// The approval inbox (architecture §8): the FULL intent — what the agent
// wants to do, to what, on whose behalf, with which arguments — and
// approve/deny with comment. Approvers act; everyone else reads.
export default async function ApprovalsPage() {
  const session = await requireSession();
  const canApprove = can(session.roles, "approve_intents");
  const rows = await pendingApprovalsView(await getStore());

  return (
    <main>
      <p>
        signed in as <b>{session.principal}</b> ({session.roles.join(", ")}) ·{" "}
        <Link href="/runs">runs</Link>
      </p>
      <h2 style={{ fontSize: 16 }}>
        approval inbox ({rows.length} pending{canApprove ? "" : " — read-only for your roles"})
      </h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>run</th>
            <th style={cell}>agent</th>
            <th style={cell}>on behalf of</th>
            <th style={cell}>wants to</th>
            <th style={cell}>risk</th>
            <th style={cell}>arguments</th>
            <th style={cell}>requested (UTC)</th>
            <th style={cell}>expires (UTC)</th>
            {canApprove ? <th style={cell}>decision</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
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
                <pre style={{ margin: 0 }}>{JSON.stringify(row.args, null, 2)}</pre>
              </td>
              <td style={cell}>{formatUtc(row.requestedAt)}</td>
              <td style={cell}>{formatUtc(row.expiresAt)}</td>
              {canApprove ? (
                <td style={cell}>
                  <form action={`/api/approvals/${encodeURIComponent(row.runId)}`} method="post">
                    <input name="comment" placeholder="comment (optional)" />{" "}
                    <button type="submit" name="decision" value="approve">
                      approve
                    </button>{" "}
                    <button type="submit" name="decision" value="deny">
                      deny
                    </button>
                  </form>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
