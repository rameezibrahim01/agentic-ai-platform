import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { getStore } from "../../lib/store";
import { formatUsd, formatUtc, runListView } from "../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

export default async function RunsPage() {
  const session = await requireSession();
  const store = await getStore(session.tenant);
  if (store === null) {
    return (
      <main>
        <p>
          this deployment is tenanted and your session is not bound to a tenant — there is
          nothing to show. Ask an admin to set a tenant on your account (or map your IdP
          claim), then sign in again.
        </p>
        <p>
          platform operators: the cross-tenant health view is at{" "}
          <Link href="/tenants">tenants</Link>.
        </p>
      </main>
    );
  }
  const rows = await runListView(store);
  return (
    <main>
      <p>
        signed in as <b>{session.principal}</b> ({session.roles.join(", ")}){" "}
        <form action="/api/logout" method="post" style={{ display: "inline" }}>
          <button type="submit">sign out</button>
        </form>
      </p>
      <h2 style={{ fontSize: 16 }}>
        runs ({rows.length}) · <Link href="/agents">agents</Link> ·{" "}
        <Link href="/approvals">approval inbox</Link>
      </h2>
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
