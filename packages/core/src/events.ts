import { z } from "zod";

// Every event carries { runId, seq, at }; `at` is epoch milliseconds UTC (CLAUDE.md #1).
const eventBase = {
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
};

export const riskTierSchema = z.enum(["read", "write", "irreversible", "financial"]);
export type RiskTier = z.infer<typeof riskTierSchema>;

export const policyDecisionSchema = z.enum(["allow", "deny", "require_approval"]);
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const runStartedSchema = z
  .object({
    ...eventBase,
    type: z.literal("RunStarted"),
    agent: z.string().min(1), // e.g. "support-triage@v14"
    principal: z.string().min(1), // e.g. "user:jane"
    input: z.unknown(),
  })
  .strict();

export const modelCalledSchema = z
  .object({
    ...eventBase,
    type: z.literal("ModelCalled"),
    gatewayReqId: z.string().min(1),
    model: z.string().min(1),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().finite(),
  })
  .strict();

export const toolIntentEmittedSchema = z
  .object({
    ...eventBase,
    type: z.literal("ToolIntentEmitted"),
    tool: z.string().min(1), // e.g. "zendesk.update_ticket@v3"
    args: z.record(z.unknown()),
    risk: riskTierSchema,
  })
  .strict();

export const policyEvaluatedSchema = z
  .object({
    ...eventBase,
    type: z.literal("PolicyEvaluated"),
    decision: policyDecisionSchema,
    rule: z.string().min(1),
  })
  .strict();

export const approvalRequestedSchema = z
  .object({
    ...eventBase,
    type: z.literal("ApprovalRequested"),
    approverGroup: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export const approvalGrantedSchema = z
  .object({
    ...eventBase,
    type: z.literal("ApprovalGranted"),
    by: z.string().min(1),
    comment: z.string().optional(),
  })
  .strict();

export const approvalDeniedSchema = z
  .object({
    ...eventBase,
    type: z.literal("ApprovalDenied"),
    by: z.string().min(1),
    comment: z.string().optional(),
  })
  .strict();

export const toolExecutedSchema = z
  .object({
    ...eventBase,
    type: z.literal("ToolExecuted"),
    gatewayReqId: z.string().min(1),
    resultDigest: z.string().min(1),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

export const toolFailedSchema = z
  .object({
    ...eventBase,
    type: z.literal("ToolFailed"),
    error: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const budgetExceededSchema = z
  .object({
    ...eventBase,
    type: z.literal("BudgetExceeded"),
    // Refined to a closed enum by ticket 005 (MaxSteps | MaxTokens | MaxCostUsd | MaxWallMs | LoopDetected).
    reason: z.string().min(1),
    detail: z.string().optional(),
  })
  .strict();

export const runCompletedSchema = z
  .object({
    ...eventBase,
    type: z.literal("RunCompleted"),
    outcome: z.string().min(1),
    totalCostUsd: z.number().nonnegative().finite(),
    steps: z.number().int().nonnegative(),
  })
  .strict();

export const runFailedSchema = z
  .object({
    ...eventBase,
    type: z.literal("RunFailed"),
    reason: z.string().min(1),
  })
  .strict();

export const runEventSchema = z.discriminatedUnion("type", [
  runStartedSchema,
  modelCalledSchema,
  toolIntentEmittedSchema,
  policyEvaluatedSchema,
  approvalRequestedSchema,
  approvalGrantedSchema,
  approvalDeniedSchema,
  toolExecutedSchema,
  toolFailedSchema,
  budgetExceededSchema,
  runCompletedSchema,
  runFailedSchema,
]);

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];

export type RunStarted = z.infer<typeof runStartedSchema>;
export type ModelCalled = z.infer<typeof modelCalledSchema>;
export type ToolIntentEmitted = z.infer<typeof toolIntentEmittedSchema>;
export type PolicyEvaluated = z.infer<typeof policyEvaluatedSchema>;
export type ApprovalRequested = z.infer<typeof approvalRequestedSchema>;
export type ApprovalGranted = z.infer<typeof approvalGrantedSchema>;
export type ApprovalDenied = z.infer<typeof approvalDeniedSchema>;
export type ToolExecuted = z.infer<typeof toolExecutedSchema>;
export type ToolFailed = z.infer<typeof toolFailedSchema>;
export type BudgetExceeded = z.infer<typeof budgetExceededSchema>;
export type RunCompleted = z.infer<typeof runCompletedSchema>;
export type RunFailed = z.infer<typeof runFailedSchema>;

export type ParseEventResult =
  | { ok: true; event: RunEvent }
  | { ok: false; issues: z.ZodIssue[] };

/** Boundary validation: unknown input in, typed event or zod issues out. Never throws. */
export function parseEvent(value: unknown): ParseEventResult {
  const result = runEventSchema.safeParse(value);
  return result.success
    ? { ok: true, event: result.data }
    : { ok: false, issues: result.error.issues };
}
