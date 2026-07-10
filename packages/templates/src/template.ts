import { z } from "zod";

// Run templates (architecture §3, ticket 023): invocations are configuration
// too. A template binds an agent version to concrete parameters as a saved,
// shareable object — with an owner and EXPLICIT share grants, because
// "developer in the workspace" must never silently mean "may fire the refund
// agent." Pure objects: no I/O, no clock.

export const templateAccessSchema = z.enum(["view", "edit", "trigger"]);
export type TemplateAccess = z.infer<typeof templateAccessSchema>;

const budgetSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxWallMs: z.number().int().positive().optional(),
  })
  .strict();

export const runTemplateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** The owner may do everything; everyone else needs an explicit grant. */
    owner: z.string().min(1),
    agent: z.string().min(1),
    params: z
      .object({
        model: z.string().min(1),
        prompt: z.string().min(1),
        input: z.record(z.unknown()).default({}),
        budget: budgetSchema.optional(),
        approvalTtlMs: z.number().int().positive().optional(),
        /** Standing authority still resolves per-occurrence via ticket 020. */
        standingGrantId: z.string().min(1).optional(),
      })
      .strict(),
    grants: z
      .array(z.object({ principal: z.string().min(1), access: templateAccessSchema }).strict())
      .default([]),
    /** Bumped on every update — stale writes are detectable. */
    rev: z.number().int().nonnegative().default(0),
  })
  .strict();

export type RunTemplate = z.infer<typeof runTemplateSchema>;

/**
 * The access matrix: owner → everything; `edit` implies `view`;
 * `trigger` is granted explicitly and NEVER implied — being allowed to edit
 * a template is not being allowed to fire it.
 */
export function canOnTemplate(
  template: RunTemplate,
  principal: string,
  action: TemplateAccess,
): boolean {
  if (principal === template.owner) return true;
  return template.grants.some(
    (grant) =>
      grant.principal === principal &&
      (grant.access === action || (action === "view" && grant.access === "edit")),
  );
}
