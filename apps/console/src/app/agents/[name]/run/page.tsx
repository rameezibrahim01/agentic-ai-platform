import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import Link from "next/link";
import { can } from "@platform/auth";
import { requireSession } from "../../../../lib/auth";
import { readAgentsConfig } from "../../../../lib/agents";
import { mintRunId } from "../../../../lib/launch";

export const dynamic = "force-dynamic";

// Run launcher (ticket 054): pick the resolved version, type an input, go.
// The runId is minted HERE, at render — resubmitting the form is a duplicate
// start that lands on the same run, so a double-click never runs twice.

export default async function RunAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { name: encoded } = await params;
  const { error } = await searchParams;
  const name = decodeURIComponent(encoded);
  const env = process.env["PLATFORM_ENV"] ?? "prod";
  const registry = await readAgentsConfig(process.env, (path) => readFile(path, "utf8"));

  if (!can(session.roles, "start_runs")) {
    return (
      <main>
        <h2 style={{ fontSize: 16 }}>
          run {name} · <Link href={`/agents/${encodeURIComponent(name)}`}>back</Link>
        </h2>
        <p>
          starting runs requires the <b>agent_developer</b> (or platform_admin) role — your
          session has: {session.roles.join(", ")}.
        </p>
      </main>
    );
  }
  if (!registry.ok) {
    return (
      <main>
        <h2 style={{ fontSize: 16 }}>
          run {name} · <Link href="/agents">all agents</Link>
        </h2>
        <p style={{ color: "#b00" }}>
          {registry.kind === "not-configured"
            ? "no AGENTS_CONFIG mounted — there is nothing to run."
            : `the agents registry file is broken: ${registry.error}`}
        </p>
      </main>
    );
  }

  const id = registry.config.aliases[name]?.[env]?.current;
  const spec = registry.config.versions.find((v) => v.id === id);
  if (id === undefined || spec === undefined) {
    return (
      <main>
        <h2 style={{ fontSize: 16 }}>
          run {name} · <Link href={`/agents/${encodeURIComponent(name)}`}>back</Link>
        </h2>
        <p>
          no <b>{env}</b> pointer for “{name}” — promote a version to {env} first (or the agent
          does not exist).
        </p>
      </main>
    );
  }

  const runId = mintRunId(randomBytes(12).toString("hex"));
  return (
    <main>
      <h2 style={{ fontSize: 16 }}>
        run {name} · <Link href={`/agents/${encodeURIComponent(name)}`}>agent page</Link> ·{" "}
        <Link href="/runs">runs</Link>
      </h2>
      {error ? (
        <p style={{ color: "#b00" }}>
          that run didn’t start: <b>{error}</b>
        </p>
      ) : null}
      <p>
        this will start <b>{id}</b> (the {env} pointer) as <b>{session.principal}</b> — model{" "}
        {spec.model}, budget {spec.budget ? JSON.stringify(spec.budget) : "engine default"}.
        Governed writes will pause in the <Link href="/approvals">approval inbox</Link>.
      </p>
      <form action="/api/runs" method="post" style={{ maxWidth: 640 }}>
        <input type="hidden" name="agent" value={name} />
        <input type="hidden" name="runId" value={runId} />
        <p>
          input
          <br />
          <textarea name="input" rows={4} style={{ width: "100%" }} placeholder="what should this run work on?" />
        </p>
        <p>
          <label>
            <input type="radio" name="inputMode" value="text" defaultChecked /> free text
          </label>{" "}
          <label>
            <input type="radio" name="inputMode" value="json" /> JSON object
          </label>
        </p>
        <button type="submit">start run {runId}</button>
      </form>
    </main>
  );
}
