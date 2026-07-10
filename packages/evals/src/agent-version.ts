import { z } from "zod";
import { riskTierSchema } from "@platform/core";

// Immutable agent versions (build-plan Phase 3, ticket 027): an agent is
// configuration — prompt, model, budgets, tool surface — pinned under an
// id that NEVER changes meaning. Improving an agent mints name@vN+1;
// mutating a published version is the failure mode 028's digest check
// exists to catch.

const budgetSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxWallMs: z.number().int().positive().optional(),
  })
  .strict();

const loopDetectionSchema = z
  .object({
    threshold: z.number().int().positive().optional(),
    windowSize: z.number().int().positive().optional(),
    numberPrecision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const agentVersionSpecSchema = z
  .object({
    /** "name@vN" — the version IS part of the identity. */
    id: z.string().regex(/^[a-z][a-z0-9-]*@v[0-9]+$/, 'agent id must be "name@vN"'),
    description: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().min(1),
    budget: budgetSchema.optional(),
    loopDetection: loopDetectionSchema.optional(),
    approvalTtlMs: z.number().int().positive().optional(),
    /**
     * The tool surface this version is designed against (risk included so
     * eval worlds can build real contracts). Deployment grants still come
     * from the deployment config — this documents intent, it grants nothing.
     */
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            version: z.string().min(1),
            risk: riskTierSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type AgentVersionSpec = z.infer<typeof agentVersionSpecSchema>;

export type ParseAgentVersionResult =
  | { ok: true; spec: AgentVersionSpec }
  | { ok: false; error: string };

export function parseAgentVersion(raw: unknown): ParseAgentVersionResult {
  const parsed = agentVersionSpecSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, spec: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
}
