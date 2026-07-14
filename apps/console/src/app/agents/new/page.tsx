import { readFile } from "node:fs/promises";
import Link from "next/link";
import { can } from "@platform/auth";
import { requireSession } from "../../../lib/auth";
import { readAgentsConfig } from "../../../lib/agents";
import { readModelOptions, readToolOptions } from "../../../lib/pickers";
import { AGENT_TEMPLATES, partitionTemplateTools, templateById } from "../../../lib/templates";

export const dynamic = "force-dynamic";

// The agent builder form (ticket 053) + templates (ticket 059). The form is
// convenience — the POST re-validates everything with zod and the 047-style
// write path refuses anything the schema or immutability discipline rejects.
// A template is ONLY a pre-filled form; missing connectors render disabled
// with copy, never as a silent half-template.

const RISKS = ["read", "write", "irreversible", "financial"] as const;

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; template?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { from, template: templateId, error } = await searchParams;
  const read = (path: string) => readFile(path, "utf8");
  const [models, tools, registry] = await Promise.all([
    readModelOptions(process.env, read),
    readToolOptions(process.env, read),
    readAgentsConfig(process.env, read),
  ]);

  if (!can(session.roles, "author_agents")) {
    return (
      <main>
        <h2 style={{ fontSize: 16 }}>
          new agent · <Link href="/agents">all agents</Link>
        </h2>
        <p>
          creating agent versions requires the <b>agent_developer</b> (or platform_admin) role —
          your session has: {session.roles.join(", ")}.
        </p>
      </main>
    );
  }

  // prefill precedence: template (?template=) > newest version (?from=);
  // an unknown template id falls back to the blank form, never a crash
  const template = templateById(templateId);
  const source =
    from !== undefined && registry.ok
      ? registry.config.versions
          .filter((v) => v.id.startsWith(`${from}@v`))
          .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0]
      : undefined;
  const draft = template?.draft ?? source;
  const templateTools = template ? partitionTemplateTools(template, tools) : undefined;
  const preTools = new Map(
    (templateTools?.available ?? source?.tools ?? []).map((t) => [`${t.name}@${t.version}`, t.risk]),
  );

  return (
    <main>
      <h2 style={{ fontSize: 16 }}>
        {template ? `new agent from template: ${template.title}` : source ? `new version of ${from}` : "new agent"}{" "}
        · <Link href="/agents">all agents</Link>
      </h2>
      {error ? (
        <p style={{ color: "#b00" }}>
          that didn’t save: <b>{error}</b>
        </p>
      ) : null}
      {!template && !source ? (
        <>
          <p>Start from a job, or fill in the blank form below.</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", maxWidth: 900 }}>
            {AGENT_TEMPLATES.map((entry) => (
              <div key={entry.id} style={{ border: "1px solid #ccc", padding: "8px 12px", maxWidth: 280 }}>
                <p style={{ margin: "4px 0" }}>
                  <b>{entry.title}</b>
                </p>
                <p style={{ margin: "4px 0" }}>{entry.blurb}</p>
                <p style={{ margin: "4px 0" }}>
                  <i>needs: {entry.needs}</i>
                </p>
                <p style={{ margin: "4px 0" }}>
                  <Link href={`/agents/new?template=${encodeURIComponent(entry.id)}`}>
                    use this template
                  </Link>
                </p>
              </div>
            ))}
          </div>
          <hr />
        </>
      ) : null}
      {templateTools && templateTools.missing.length > 0 ? (
        <p style={{ color: "#b06000" }}>
          this template also uses{" "}
          <b>{templateTools.missing.map((t) => `${t.name}@${t.version}`).join(", ")}</b> — not
          configured on this deployment (see DEPLOYMENT.md, connectors). The agent will be
          created without them.
        </p>
      ) : null}
      <p>
        Saving creates an <b>immutable</b> version (name@vN) — improving it later means saving
        again, never editing. A brand-new name starts with its <b>dev</b> pointer only; prod is a
        promotion (ticket 055).
      </p>
      <form action="/api/agents" method="post" style={{ maxWidth: 640 }}>
        <p>
          name{" "}
          {source && from ? (
            <>
              <b>{from}</b>
              <input type="hidden" name="name" value={from} />
            </>
          ) : (
            <input
              name="name"
              required
              pattern="[a-z][a-z0-9-]*"
              placeholder={template?.id ?? "invoice-triage"}
              defaultValue={template?.id ?? ""}
            />
          )}
        </p>
        <p>
          description
          <br />
          <input
            name="description"
            required
            defaultValue={draft?.description ?? ""}
            style={{ width: "100%" }}
          />
        </p>
        <p>
          prompt (what this agent is told to do)
          <br />
          <textarea
            name="prompt"
            required
            rows={6}
            defaultValue={draft?.prompt ?? ""}
            style={{ width: "100%" }}
          />
        </p>
        <p>
          model{" "}
          <select name="model" defaultValue={draft?.model ?? models[0]}>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </p>
        <fieldset>
          <legend>tools (documents intent — the run still needs a grant in the deployment tools config)</legend>
          {tools.length === 0 ? (
            <p>no TOOLS_CONFIG mounted — this version will declare no tools.</p>
          ) : (
            tools.map((tool) => {
              const key = `${tool.name}@${tool.version}`;
              return (
                <p key={key} style={{ margin: "4px 0" }}>
                  <label>
                    <input
                      type="checkbox"
                      name="tool"
                      value={key}
                      defaultChecked={preTools.has(key)}
                    />{" "}
                    {key}
                  </label>{" "}
                  {tool.risk !== undefined ? (
                    <>
                      <i>({tool.risk})</i>
                      <input type="hidden" name={`risk:${key}`} value={tool.risk} />
                    </>
                  ) : (
                    <select name={`risk:${key}`} defaultValue={preTools.get(key) ?? "write"}>
                      {RISKS.map((risk) => (
                        <option key={risk} value={risk}>
                          {risk}
                        </option>
                      ))}
                    </select>
                  )}
                </p>
              );
            })
          )}
        </fieldset>
        <p>
          budget — max steps{" "}
          <input
            name="maxSteps"
            type="number"
            min={1}
            defaultValue={draft?.budget?.maxSteps ?? 10}
            style={{ width: 70 }}
          />{" "}
          max cost USD{" "}
          <input
            name="maxCostUsd"
            type="number"
            step="0.01"
            min={0}
            defaultValue={draft?.budget?.maxCostUsd ?? ""}
            style={{ width: 90 }}
          />{" "}
          (blank = engine default)
        </p>
        <p>
          approval wait before expiry-to-deny, minutes{" "}
          <input
            name="approvalTtlMinutes"
            type="number"
            min={1}
            defaultValue={
              draft?.approvalTtlMs !== undefined ? draft.approvalTtlMs / 60_000 : ""
            }
            style={{ width: 70 }}
          />{" "}
          (blank = 60)
        </p>
        <button type="submit">save immutable version</button>
      </form>
    </main>
  );
}
