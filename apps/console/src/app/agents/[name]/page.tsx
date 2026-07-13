import { readFile } from "node:fs/promises";
import Link from "next/link";
import type { SessionClaims } from "@platform/auth";
import { requireSession } from "../../../lib/auth";
import { catalogRowFor, pointerRefs, readAgentsConfig } from "../../../lib/agents";
import { evalStatusFor, pointerGate } from "../../../lib/promote";

// promote/rollback controls (055) render only for sessions the gate admits —
// the POST re-checks everything server-side either way
function canMove(session: Pick<SessionClaims, "roles">, env: string): boolean {
  return pointerGate(session, env) === "admitted";
}

export const dynamic = "force-dynamic";

// One agent's version history (ticket 052). Versions are immutable (028) —
// this page shows every one that ever shipped, which env pointers reference
// it, and what a rollback would restore.

const cell: React.CSSProperties = { border: "1px solid #ccc", padding: "4px 8px", textAlign: "left", verticalAlign: "top" };

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const session = await requireSession();
  const { name: encoded } = await params;
  const name = decodeURIComponent(encoded);
  const result = await readAgentsConfig(process.env, (path) => readFile(path, "utf8"));

  if (!result.ok) {
    return (
      <main>
        <h2 style={{ fontSize: 16 }}>
          agent {name} · <Link href="/agents">all agents</Link>
        </h2>
        {result.kind === "not-configured" ? (
          <p>no AGENTS_CONFIG mounted — this deployment has no agent registry.</p>
        ) : (
          <p style={{ color: "#b00" }}>
            the agents registry file is broken: <code>{result.error}</code>
          </p>
        )}
      </main>
    );
  }

  const row = catalogRowFor(result.config, name);
  if (row === undefined) {
    return (
      <main>
        <h2 style={{ fontSize: 16 }}>
          agent {name} · <Link href="/agents">all agents</Link>
        </h2>
        <p>no agent named “{name}” is registered.</p>
      </main>
    );
  }

  return (
    <main>
      <h2 style={{ fontSize: 16 }}>
        agent {row.name} · <Link href="/agents">all agents</Link> ·{" "}
        <Link href={`/agents/${encodeURIComponent(row.name)}/run`}>run it</Link> ·{" "}
        <Link href={`/agents/new?from=${encodeURIComponent(row.name)}`}>new version</Link> ·{" "}
        <Link href="/runs">runs</Link>
      </h2>
      {row.aliased ? (
        row.envs.map(([env, pointer]) => (
          <p key={env}>
            <b>{env}</b>: {pointer.current}
            {pointer.previous !== undefined ? ` (previous ${pointer.previous})` : ""}{" "}
            {canMove(session, env) ? (
              <>
                <form action="/api/agents/pointer" method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="kind" value="promote" />
                  <input type="hidden" name="name" value={row.name} />
                  <input type="hidden" name="env" value={env} />
                  <select name="to" defaultValue={pointer.current}>
                    {row.versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.id}
                        {evalStatusFor(version.id) === "unproven" ? " (unproven — no eval suite)" : ""}
                      </option>
                    ))}
                  </select>{" "}
                  <button type="submit">promote to {env}</button>
                </form>{" "}
                {pointer.previous !== undefined ? (
                  <form action="/api/agents/pointer" method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="kind" value="rollback" />
                    <input type="hidden" name="name" value={row.name} />
                    <input type="hidden" name="env" value={env} />
                    <button type="submit">rollback (restores {pointer.previous})</button>
                  </form>
                ) : null}
              </>
            ) : null}
          </p>
        ))
      ) : (
        <p>no alias — versions below are reachable only as direct name@vN references</p>
      )}
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={cell}>version</th>
            <th style={cell}>spec</th>
            <th style={cell}>tools</th>
            <th style={cell}>referenced by</th>
          </tr>
        </thead>
        <tbody>
          {row.versions.map((version) => {
            const refs = pointerRefs(row, version.id);
            return (
              <tr key={version.id}>
                <td style={cell}>
                  <b>{version.id}</b>
                  <br />
                  {version.description}
                </td>
                <td style={cell}>
                  model: {version.model}
                  <br />
                  budget: {version.budget ? JSON.stringify(version.budget) : "engine default"}
                  <br />
                  loop detection:{" "}
                  {version.loopDetection ? JSON.stringify(version.loopDetection) : "default"}
                  <br />
                  approval TTL:{" "}
                  {version.approvalTtlMs !== undefined ? `${version.approvalTtlMs} ms` : "default"}
                  <br />
                  prompt: <code style={{ whiteSpace: "pre-wrap" }}>{version.prompt}</code>
                </td>
                <td style={cell}>
                  {version.tools.length === 0
                    ? "none"
                    : version.tools.map((tool) => (
                        <div key={`${tool.name}@${tool.version}`}>
                          {tool.name}@{tool.version} <i>({tool.risk})</i>
                        </div>
                      ))}
                </td>
                <td style={cell}>{refs.length === 0 ? "no pointer" : refs.join(", ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
