// Workflow code MUST stay deterministic (CLAUDE.md; ticket 003 scope 3): no
// I/O, no randomness. Date.now() here is Temporal's workflow time — patched
// by the workflow sandbox to be deterministic and replay-safe. "Pause for
// human" is just an event the workflow awaits (architecture §4): approval
// waits are a signal + timer race, and expiry defaults to deny (§8).
import { condition, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import { checkBudget, detectLoop } from "@platform/core";
import type { BudgetPolicy, BudgetReason, LoopDetectionConfig, ToolIntentLike } from "@platform/core";
import type { Activities } from "./activities.js";

const {
  startRun,
  callModel,
  resolveIntent,
  recordApprovalDecision,
  executeApprovedIntent,
  completeRun,
  recordBudgetFailure,
} = proxyActivities<Activities>({
  startToCloseTimeout: "10 seconds",
  retry: {
    initialInterval: "50 milliseconds",
    backoffCoefficient: 2,
    maximumInterval: "2 seconds",
  },
});

export interface ApprovalDecision {
  granted: boolean;
  by: string;
  comment?: string;
}

export const approvalDecisionSignal = defineSignal<[ApprovalDecision]>("approvalDecision");

export interface AgentRunInput {
  /** Omitted for scheduled runs: the workflow adopts its workflowId (ticket 010). */
  runId?: string;
  agent: string;
  principal: string;
  input: unknown;
  model: string;
  prompt: string;
  /** Engine-enforced budgets (ticket 005). Default: { maxSteps: 10 }. */
  budget?: BudgetPolicy;
  loopDetection?: LoopDetectionConfig;
  /** Approval wait before expiry-to-deny (ticket 017). Default 1h. */
  approvalTtlMs?: number;
  approverGroup?: string;
  /** Delegated credential for governed intents; never inspected here (ticket 019). */
  delegation?: string;
}

export type AgentRunResult =
  | { outcome: "completed"; version: number; steps: number }
  | {
      outcome: "budget_exceeded";
      reason: BudgetReason | "LoopDetected";
      version: number;
      steps: number;
    };

export async function agentRun(input: AgentRunInput): Promise<AgentRunResult> {
  const runId = input.runId ?? workflowInfo().workflowId; // deterministic API
  const budget: BudgetPolicy = input.budget ?? { maxSteps: 10 };
  const approvalTtlMs = input.approvalTtlMs ?? 60 * 60 * 1000;
  const approverGroup = input.approverGroup ?? "approvers";
  const startedAt = Date.now(); // deterministic workflow time
  const usage = { stepCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt };
  const intents: ToolIntentLike[] = [];

  let pendingDecision: ApprovalDecision | undefined;
  setHandler(approvalDecisionSignal, (decision) => {
    pendingDecision = decision;
  });

  let { version } = await startRun({
    runId,
    agent: input.agent,
    principal: input.principal,
    input: input.input,
  });

  for (;;) {
    // Engine enforcement BEFORE every step — the model is never asked to behave.
    const budgetCheck = checkBudget(usage, budget, Date.now());
    if (!budgetCheck.ok) {
      const failed = await recordBudgetFailure({
        runId,
        expectedVersion: version,
        reason: budgetCheck.reason,
        detail: budgetCheck.detail,
      });
      return {
        outcome: "budget_exceeded",
        reason: budgetCheck.reason,
        version: failed.version,
        steps: usage.stepCount,
      };
    }

    const model = await callModel({
      runId,
      expectedVersion: version,
      model: input.model,
      prompt: input.prompt,
    });
    version = model.version;
    usage.stepCount += 1;
    usage.tokensIn += model.usage.tokensIn;
    usage.tokensOut += model.usage.tokensOut;
    usage.costUsd += model.costUsd;

    if (model.kind === "message") {
      const completed = await completeRun({
        runId,
        expectedVersion: version,
        outcome: model.content,
        totalCostUsd: usage.costUsd,
        steps: usage.stepCount,
      });
      return { outcome: "completed", version: completed.version, steps: usage.stepCount };
    }

    intents.push({ tool: model.tool, args: model.args });
    const loopCheck = detectLoop(intents, input.loopDetection);
    if (loopCheck.loop) {
      const failed = await recordBudgetFailure({
        runId,
        expectedVersion: version,
        reason: "LoopDetected",
        detail: `intent ${loopCheck.key} repeated ${loopCheck.count}x`,
      });
      return {
        outcome: "budget_exceeded",
        reason: "LoopDetected",
        version: failed.version,
        steps: usage.stepCount,
      };
    }

    // Every intent goes through the tool gateway; refusals are audited and
    // the run survives (the model is told, not crashed).
    const resolved = await resolveIntent({
      runId,
      expectedVersion: version,
      agent: input.agent,
      principal: input.principal,
      tool: model.tool,
      args: model.args,
      approverGroup,
      approvalTtlMs,
      ...(input.delegation !== undefined ? { delegation: input.delegation } : {}),
    });
    version = resolved.version;

    if (resolved.kind === "approval_required") {
      // pause for human: signal or expiry, whichever first; expiry = deny
      const signalled = await condition(() => pendingDecision !== undefined, approvalTtlMs);
      const decision: ApprovalDecision =
        signalled && pendingDecision !== undefined
          ? pendingDecision
          : { granted: false, by: "system:expiry", comment: "approval expired" };
      pendingDecision = undefined;

      const recorded = await recordApprovalDecision({
        runId,
        expectedVersion: version,
        granted: decision.granted,
        by: decision.by,
        ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
      });
      version = recorded.version;

      if (decision.granted) {
        const executed = await executeApprovedIntent({
          runId,
          expectedVersion: version,
          agent: input.agent,
          principal: input.principal,
          tool: model.tool,
          args: model.args,
          ...(input.delegation !== undefined ? { delegation: input.delegation } : {}),
        });
        version = executed.version;
      }
    }
  }
}
