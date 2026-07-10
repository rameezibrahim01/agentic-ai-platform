import { canOnTemplate, runTemplateSchema } from "./template.js";
import type { RunTemplate } from "./template.js";
import { webhookTriggerSchema } from "./webhook.js";
import type { WebhookTrigger } from "./webhook.js";

// In-memory stores, same shape discipline as GrantStore (020): typed results
// across the boundary, permanent disables, zod at construction. Postgres
// persistence is out of scope for 023.

export type TemplateWriteResult =
  | { ok: true; template: RunTemplate }
  | { ok: false; error: string };

export interface TemplateStore {
  create(template: RunTemplate): Promise<TemplateWriteResult>;
  get(id: string): Promise<RunTemplate | undefined>;
  /** Edit-gated by the acting principal; bumps `rev`. */
  update(
    id: string,
    principal: string,
    patch: Partial<Pick<RunTemplate, "name" | "params" | "grants">>,
  ): Promise<TemplateWriteResult>;
  /** Everything the principal owns or holds any grant on. */
  listFor(principal: string): Promise<RunTemplate[]>;
}

export class InMemoryTemplateStore implements TemplateStore {
  private readonly templates = new Map<string, RunTemplate>();

  async create(template: RunTemplate): Promise<TemplateWriteResult> {
    const parsed = runTemplateSchema.safeParse(template);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    if (this.templates.has(parsed.data.id)) {
      return { ok: false, error: `template ${parsed.data.id} already exists` };
    }
    this.templates.set(parsed.data.id, parsed.data);
    return { ok: true, template: parsed.data };
  }

  async get(id: string): Promise<RunTemplate | undefined> {
    return this.templates.get(id);
  }

  async update(
    id: string,
    principal: string,
    patch: Partial<Pick<RunTemplate, "name" | "params" | "grants">>,
  ): Promise<TemplateWriteResult> {
    const existing = this.templates.get(id);
    if (existing === undefined) return { ok: false, error: "not_found" };
    if (!canOnTemplate(existing, principal, "edit")) return { ok: false, error: "forbidden" };
    const parsed = runTemplateSchema.safeParse({ ...existing, ...patch, rev: existing.rev + 1 });
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    this.templates.set(id, parsed.data);
    return { ok: true, template: parsed.data };
  }

  async listFor(principal: string): Promise<RunTemplate[]> {
    return [...this.templates.values()].filter(
      (t) => t.owner === principal || t.grants.some((g) => g.principal === principal),
    );
  }
}

export type TriggerWriteResult =
  | { ok: true; trigger: WebhookTrigger }
  | { ok: false; error: string };

export interface TriggerStore {
  /** Registration requires the creator to hold `trigger` access on the template. */
  create(trigger: WebhookTrigger, template: RunTemplate): Promise<TriggerWriteResult>;
  get(id: string): Promise<WebhookTrigger | undefined>;
  /** One call, permanent — like grant revocation (020). */
  disable(id: string): Promise<TriggerWriteResult>;
  listForTemplate(templateId: string): Promise<WebhookTrigger[]>;
}

export class InMemoryTriggerStore implements TriggerStore {
  private readonly triggers = new Map<string, WebhookTrigger>();

  async create(trigger: WebhookTrigger, template: RunTemplate): Promise<TriggerWriteResult> {
    const parsed = webhookTriggerSchema.safeParse(trigger);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    if (parsed.data.templateId !== template.id) {
      return { ok: false, error: "trigger.templateId does not match the template" };
    }
    if (!canOnTemplate(template, parsed.data.createdBy, "trigger")) {
      return { ok: false, error: "forbidden" };
    }
    if (this.triggers.has(parsed.data.id)) {
      return { ok: false, error: `trigger ${parsed.data.id} already exists` };
    }
    this.triggers.set(parsed.data.id, parsed.data);
    return { ok: true, trigger: parsed.data };
  }

  async get(id: string): Promise<WebhookTrigger | undefined> {
    return this.triggers.get(id);
  }

  async disable(id: string): Promise<TriggerWriteResult> {
    const existing = this.triggers.get(id);
    if (existing === undefined) return { ok: false, error: "not_found" };
    const disabled: WebhookTrigger = { ...existing, enabled: false };
    this.triggers.set(id, disabled);
    return { ok: true, trigger: disabled };
  }

  async listForTemplate(templateId: string): Promise<WebhookTrigger[]> {
    return [...this.triggers.values()].filter((t) => t.templateId === templateId);
  }
}
