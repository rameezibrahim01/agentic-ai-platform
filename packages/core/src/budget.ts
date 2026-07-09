import type { RunState } from "./state.js";

/** Per-run budgets, enforced by the ENGINE — never by prompting (CLAUDE.md #7). */
export interface BudgetPolicy {
  maxSteps?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallMs?: number;
}

export type BudgetReason = "MaxSteps" | "MaxTokens" | "MaxCostUsd" | "MaxWallMs";

export type BudgetCheck =
  | { ok: true }
  | { ok: false; reason: BudgetReason; detail: string };

/** The slice of RunState budget checking needs; RunState satisfies it structurally. */
export type BudgetUsage = Pick<
  RunState,
  "stepCount" | "tokensIn" | "tokensOut" | "costUsd" | "startedAt"
>;

/**
 * Pure and deterministic: same usage, policy, and clock reading — same answer.
 * `nowMs` is injected (no clock in core). Semantics: steps are checked as
 * "may another step start" (>= limit blocks), token/cost/wall-clock as
 * "already over" (> limit trips) — so totals can overshoot by at most the
 * final call that crossed the line, never accrue further.
 */
export function checkBudget(
  usage: BudgetUsage,
  policy: BudgetPolicy,
  nowMs: number,
): BudgetCheck {
  if (policy.maxSteps !== undefined && usage.stepCount >= policy.maxSteps) {
    return {
      ok: false,
      reason: "MaxSteps",
      detail: `stepCount ${usage.stepCount} reached maxSteps ${policy.maxSteps}`,
    };
  }
  const tokens = usage.tokensIn + usage.tokensOut;
  if (policy.maxTokens !== undefined && tokens > policy.maxTokens) {
    return {
      ok: false,
      reason: "MaxTokens",
      detail: `tokens ${tokens} exceeded maxTokens ${policy.maxTokens}`,
    };
  }
  if (policy.maxCostUsd !== undefined && usage.costUsd > policy.maxCostUsd) {
    return {
      ok: false,
      reason: "MaxCostUsd",
      detail: `costUsd ${usage.costUsd} exceeded maxCostUsd ${policy.maxCostUsd}`,
    };
  }
  if (policy.maxWallMs !== undefined && nowMs - usage.startedAt > policy.maxWallMs) {
    return {
      ok: false,
      reason: "MaxWallMs",
      detail: `elapsed ${nowMs - usage.startedAt}ms exceeded maxWallMs ${policy.maxWallMs}`,
    };
  }
  return { ok: true };
}
