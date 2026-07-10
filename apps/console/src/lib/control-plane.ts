import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  InMemoryTemplateStore,
  InMemoryTriggerStore,
  runTemplateSchema,
  webhookTriggerSchema,
} from "@platform/templates";
import type { TemplateStore, TriggerStore } from "@platform/templates";

// Control-plane objects for the console (ticket 023): templates and webhook
// triggers load from TRIGGERS_CONFIG (zod-validated JSON, mounted like the
// worker's TOOLS_CONFIG — configuration, never code). Without config there
// are no triggers: every delivery is a 404. An invalid config is a boot
// failure, never a silently-empty control plane. Trigger SECRETS live in the
// config file, which is mounted, not committed (CLAUDE.md #4).

const controlPlaneConfigSchema = z
  .object({
    templates: z.array(runTemplateSchema).default([]),
    triggers: z.array(webhookTriggerSchema).default([]),
  })
  .strict();

export interface ControlPlane {
  templates: TemplateStore;
  triggers: TriggerStore;
}

async function loadControlPlane(): Promise<ControlPlane> {
  const templates = new InMemoryTemplateStore();
  const triggers = new InMemoryTriggerStore();
  const configPath = process.env["TRIGGERS_CONFIG"];
  if (!configPath) return { templates, triggers };

  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const parsed = controlPlaneConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `TRIGGERS_CONFIG rejected: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  for (const template of parsed.data.templates) {
    const created = await templates.create(template);
    if (!created.ok) throw new Error(`TRIGGERS_CONFIG template ${template.id}: ${created.error}`);
  }
  for (const trigger of parsed.data.triggers) {
    const template = await templates.get(trigger.templateId);
    if (template === undefined) {
      throw new Error(`TRIGGERS_CONFIG trigger ${trigger.id}: unknown template ${trigger.templateId}`);
    }
    const created = await triggers.create(trigger, template);
    if (!created.ok) throw new Error(`TRIGGERS_CONFIG trigger ${trigger.id}: ${created.error}`);
  }
  return { templates, triggers };
}

let controlPlanePromise: Promise<ControlPlane> | null = null;

export function getControlPlane(): Promise<ControlPlane> {
  controlPlanePromise ??= loadControlPlane();
  return controlPlanePromise;
}
