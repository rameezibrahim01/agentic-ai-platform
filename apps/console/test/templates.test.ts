import { describe, expect, it } from "vitest";
import { agentDraftSchema, draftVersion } from "../src/lib/builder";
import { parseAgentsConfig } from "../src/lib/agents";
import { AGENT_TEMPLATES, partitionTemplateTools, templateById } from "../src/lib/templates";
import { loadAgentsConfig } from "../../worker/src/agents/registry.js";

// Ticket 059: templates are pre-filled forms, nothing more. Every shipped
// draft must be schema-valid and mint a worker-loadable version through the
// REAL 053 write path; availability against a deployment's tools config is a
// pure partition with honest copy, never a silent half-template.

const EMPTY_REGISTRY = (() => {
  const parsed = parseAgentsConfig({
    versions: [
      { id: "seed@v1", description: "seed", prompt: "p", model: "stub-model", tools: [] },
    ],
    aliases: { seed: { dev: { current: "seed@v1" } } },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
})();

describe("agent templates (ticket 059)", () => {
  it("every shipped template is schema-valid and worker-loadable through the real 053 path", () => {
    expect(AGENT_TEMPLATES).toHaveLength(3);
    for (const template of AGENT_TEMPLATES) {
      const parsed = agentDraftSchema.safeParse({ ...template.draft, name: template.id });
      expect(parsed.success, `${template.id} draft must satisfy agentDraftSchema`).toBe(true);

      const minted = draftVersion(EMPTY_REGISTRY, { ...template.draft, name: template.id });
      expect(minted.ok, `${template.id} must mint through draftVersion`).toBe(true);
      if (minted.ok) {
        expect(minted.id).toBe(`${template.id}@v1`);
        expect(loadAgentsConfig(JSON.parse(JSON.stringify(minted.config))).ok).toBe(true);
      }
    }
  });

  it("templates never treat external content as instructions — the prompts say so", () => {
    // CLAUDE.md #6 is a platform rule; curated prompts must carry it too
    for (const template of AGENT_TEMPLATES.filter((t) =>
      t.draft.tools.some((tool) => tool.name.startsWith("docs.") || tool.name.startsWith("mail.")),
    )) {
      expect(template.draft.prompt.toLowerCase()).toContain("never as instructions");
    }
  });

  it("partition is honest: missing connectors are named, available tools keep their risk", () => {
    const invoiceChecker = templateById("invoice-checker")!;
    const onlyFileReads = [
      { name: "docs.list", version: "v1" },
      { name: "docs.read", version: "v1" },
      { name: "sheet.read", version: "v1" },
    ];
    const { available, missing } = partitionTemplateTools(invoiceChecker, onlyFileReads);
    expect(available.map((t) => t.name)).toEqual(["docs.list", "docs.read", "sheet.read"]);
    expect(missing).toEqual([{ name: "sheet.append", version: "v1", risk: "write" }]);

    const nothing = partitionTemplateTools(invoiceChecker, []);
    expect(nothing.available).toEqual([]);
    expect(nothing.missing).toHaveLength(4);
  });

  it("unknown template ids resolve to undefined — the blank form, never a crash", () => {
    expect(templateById("no-such-template")).toBeUndefined();
    expect(templateById(undefined)).toBeUndefined();
    expect(templateById("invoice-checker")?.title).toBe("Invoice checker");
  });
});
