export const CORE_READY = true;

export {
  parseEvent,
  runEventSchema,
  riskTierSchema,
  policyDecisionSchema,
  budgetExceededReasonSchema,
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
} from "./events.js";
export type {
  BudgetExceededReason,
  ParseEventResult,
  PolicyDecision,
  RiskTier,
  RunEvent,
  RunEventType,
  RunStarted,
  ModelCalled,
  ToolIntentEmitted,
  PolicyEvaluated,
  ApprovalRequested,
  ApprovalGranted,
  ApprovalDenied,
  ToolExecuted,
  ToolFailed,
  BudgetExceeded,
  RunCompleted,
  RunFailed,
} from "./events.js";

export { reduce, replay } from "./state.js";

export { checkBudget } from "./budget.js";
export type { BudgetCheck, BudgetPolicy, BudgetReason, BudgetUsage } from "./budget.js";

export { detectLoop, detectLoopInEvents, normalizeIntentKey } from "./loop.js";
export type { LoopCheck, LoopDetectionConfig, ToolIntentLike } from "./loop.js";
export type {
  PendingApproval,
  PendingIntent,
  ReduceResult,
  Rejection,
  ReplayRejection,
  ReplayResult,
  RunOutcome,
  RunState,
  RunStatus,
} from "./state.js";
