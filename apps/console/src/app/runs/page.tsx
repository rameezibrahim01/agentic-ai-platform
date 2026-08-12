import Link from "next/link";
import type { RunStatus } from "@platform/core";
import { requireSession } from "../../lib/auth";
import { getStore } from "../../lib/store";
import { formatUsd, formatUtc, runListView } from "../../lib/viewmodels";

export const dynamic = "force-dynamic";

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

const STATUSES: RunStatus[] = ["running", "awaiting_approval", "completed", "failed"];

function pageHref(status: RunStatus | undefined, page: number): string {
  const params = new URLSearchParams();
  if (status !== undefined) params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? "/runs" : `/runs?${query}`;
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const requestedPage = Number.parseInt(params.page ?? "1", 10);
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
  const list = await runListView(store, {
    ...(status !== undefined ? { status } : {}),
    page: Number.isFinite(requestedPage) ? requestedPage : 1,
  });
  const { rows } = list;
  return (
    <main>
      <p>
        signed in as <b>{session.principal}</b> ({session.roles.join(", ")}){" "}
        <form action="/api/logout" method="post" style={{ display: "inline" }}>
          <button type="submit">sign out</button>
        </form>
      </p>
      <h2 style={{ fontSize: 16 }}>
        runs · <Link href="/agents">agents</Link> ·{" "}
        <Link href="/approvals">approval inbox</Link>
      </h2>
      <p>
        {status === undefined ? <b>all</b> : <Link href={pageHref(undefined, 1)}>all</Link>}
        {STATUSES.map((s) => (
          <span key={s}>
            {" · "}
            {s === status ? <b>{s}</b> : <Link href={pageHref(s, 1)}>{s}</Link>}
          </span>
        ))}
      </p>
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
      <p>
        {list.page > 1 && (
          <>
            <Link href={pageHref(status, list.page - 1)}>← newer</Link>
            {" · "}
          </>
        )}
        page {list.page}
        {list.hasNext && (
          <>
            {" · "}
            <Link href={pageHref(status, list.page + 1)}>older →</Link>
          </>
        )}
      </p>
    </main>
  );
}
