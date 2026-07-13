import { readFile } from "node:fs/promises";
import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { agentCatalog, readAgentsConfig } from "../../lib/agents";

export const dynamic = "force-dynamic";

// Agent registry catalog (ticket 052). Read-only: the file is the single
// source of truth, read fresh on every request. A malformed file is a LOUD
// error page — never an empty catalog pretending nothing exists.

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left" };

export default async function AgentsPage() {
  await requireSession();
  const result = await readAgentsConfig(process.env, (path) => readFile(path, "utf8"));
  return (
    <main>
      <h2 style={{ fontSize: 16 }}>
        agents · <Link href="/agents/new">create agent</Link> · <Link href="/runs">runs</Link> ·{" "}
        <Link href="/approvals">approval inbox</Link> · <Link href="/costs">costs</Link> ·{" "}
        <Link href="/limits">limits</Link>
      </h2>
      {!result.ok ? (
        result.kind === "not-configured" ? (
          <p>
            no AGENTS_CONFIG mounted — this deployment has no agent registry. Runs can still
            reference agents directly; mount agents.config.json to see them here.
          </p>
        ) : (
          <p style={{ color: "#b00" }}>
            the agents registry file is broken — fix it before trusting anything on this page.
            <br />
            <code>{result.error}</code>
          </p>
        )
      ) : (
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cell}>agent</th>
              <th style={cell}>latest version</th>
              <th style={cell}>model</th>
              <th style={cell}>tools</th>
              <th style={cell}>environment pointers</th>
              <th style={cell}>launch</th>
            </tr>
          </thead>
          <tbody>
            {agentCatalog(result.config).map((row) => {
              const latest = row.versions[0];
              return (
                <tr key={row.name}>
                  <td style={cell}>
                    <Link href={`/agents/${encodeURIComponent(row.name)}`}>{row.name}</Link>
                  </td>
                  <td style={cell}>
                    {latest ? (
                      <>
                        {latest.id} — {latest.description}
                      </>
                    ) : (
                      "no versions"
                    )}
                  </td>
                  <td style={cell}>{latest?.model ?? "—"}</td>
                  <td style={cell}>{latest?.tools.length ?? 0}</td>
                  <td style={cell}>
                    {row.aliased
                      ? row.envs.map(([env, pointer]) => `${env} → ${pointer.current}`).join(" · ")
                      : "no alias — reachable only as a direct name@vN reference"}
                  </td>
                  <td style={cell}>
                    {row.aliased ? (
                      <Link href={`/agents/${encodeURIComponent(row.name)}/run`}>run</Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
