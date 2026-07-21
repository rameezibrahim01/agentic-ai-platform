// Workflow code MUST stay deterministic (CLAUDE.md; ticket 003 scope 3): no
// I/O, no randomness. Date.now() here is Temporal's workflow time — patched
// by the workflow sandbox to be deterministic and replay-safe. "Pause for
// human" is just an event the workflow awaits (architecture §4): approval
// waits are a signal + timer race, and expiry defaults to deny (§8).
import { condition, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import { checkBudget, detectLoop } from "@platform/core";
import type {
  BudgetExceededReason,
  BudgetPolicy,
  LoopDetectionConfig,
  ToolIntentLike,
} from "@platform/core";
import type { Activities } from "./activities.js";

const {
  startRun,
  callModel,
  checkLimits,
  resolveIntent,
  resolveStandingGrant,
  recordApprovalDecision,
  recordEscalation,
  recordDelegation,
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

export interface ApprovalDelegation {
  toPrincipal: string;
  by: string;
}

/** Ticket 050: delegation rides a signal like decisions do — the workflow is
 * the single writer of an active run's log, so the fact is appended HERE. */
export const approvalDelegationSignal = defineSignal<[ApprovalDelegation]>("approvalDelegation");

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
  /** Ticket 048: after afterMs of silence the request escalates to toGroup.
   * The ORIGINAL expiry stands — escalation buys attention, never time.
   * Ignored unless afterMs < approvalTtlMs. */
  escalation?: { toGroup: string; afterMs: number };
  /** Delegated credential for governed intents; never inspected here (ticket 019). */
  delegation?: string;
  /**
   * Standing grant resolved per occurrence at run start (ticket 020). A dead
   * grant means the run proceeds WITHOUT a delegation — governed intents are
   * then refused at the gateway, never retried on a broader credential.
   */
  standingGrantId?: string;
}

export type AgentRunResult =
  | { outcome: "completed"; version: number; steps: number }
  | {
      outcome: "budget_exceeded";
      reason: BudgetExceededReason;
      version: number;
      steps: number;
    };

export async function agentRun(input: AgentRunInput): Promise<AgentRunResult> {
  const runId = input.runId ?? workflowInfo().workflowId; // deterministic API
  let budget: BudgetPolicy = input.budget ?? { maxSteps: 10 };
  const approvalTtlMs = input.approvalTtlMs ?? 60 * 60 * 1000;
  const approverGroup = input.approverGroup ?? "approvers";
  const startedAt = Date.now(); // deterministic workflow time
  const usage = { stepCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt };
  const intents: ToolIntentLike[] = [];

  let pendingDecision: ApprovalDecision | undefined;
  setHandler(approvalDecisionSignal, (decision) => {
    pendingDecision = decision;
  });
  let pendingDelegation: ApprovalDelegation | undefined;
  setHandler(approvalDelegationSignal, (delegation) => {
    pendingDelegation = delegation;
  });

  // Standing grant (ticket 020): resolved fresh at every occurrence, so a
  // revocation takes effect on the very next run. On success the exercise is
  // recorded inside the run's audited input; on refusal the run carries NO
  // delegation and the gateway blocks each governed intent.
  let delegation = input.delegation;
  let auditedInput: unknown = input.input;
  if (input.standingGrantId !== undefined) {
    const resolved = await resolveStandingGrant({
      grantId: input.standingGrantId,
      runId,
      agent: input.agent,
    });
    if (resolved.ok) {
      delegation = resolved.delegation;
      const base =
        input.input !== null && typeof input.input === "object" && !Array.isArray(input.input)
          ? (input.input as Record<string, unknown>)
          : { value: input.input };
      auditedInput = { ...base, grantExercise: resolved.exercise };
    }
  }

  let { version } = await startRun({
    runId,
    agent: input.agent,
    principal: input.principal,
    input: auditedInput,
  });

  // Operator limits at start (ticket 033): kill switch + rate limit, audited
  // as an engine-terminated run; platform caps CEILING the requested budget —
  // the request does not negotiate.
  const startLimits = await checkLimits({ agent: input.agent, runId, phase: "start" });
  if (!startLimits.ok) {
    const failed = await recordBudgetFailure({
      runId,
      expectedVersion: version,
      reason: startLimits.reason,
      detail: startLimits.detail,
    });
    return {
      outcome: "budget_exceeded",
      reason: startLimits.reason,
      version: failed.version,
      steps: 0,
    };
  }
  if (startLimits.budgetCaps !== undefined) {
    const caps = startLimits.budgetCaps;
    const fields = ["maxSteps", "maxTokens", "maxCostUsd", "maxWallMs"] as const;
    const merged: BudgetPolicy = {};
    for (const field of fields) {
      const values = [budget[field], caps[field]].filter((v): v is number => v !== undefined);
      if (values.length > 0) merged[field] = Math.min(...values);
    }
    budget = merged;
  }

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

    // a flipped kill switch stops in-flight runs at their next step
    const stepLimits = await checkLimits({ agent: input.agent, runId, phase: "step" });
    if (!stepLimits.ok) {
      const failed = await recordBudgetFailure({
        runId,
        expectedVersion: version,
        reason: stepLimits.reason,
        detail: stepLimits.detail,
      });
      return {
        outcome: "budget_exceeded",
        reason: stepLimits.reason,
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
      ...(delegation !== undefined ? { delegation } : {}),
    });
    version = resolved.version;

    if (resolved.kind === "approval_required") {
      // pause for human: signal or expiry, whichever first; expiry = deny.
      // With an escalation configured (048), the wait has two legs: silence
      // at afterMs appends ApprovalEscalated (a fact in the log, idempotent
      // under retry), then the wait continues to the ORIGINAL expiry.
      // one wait leg: until a DECISION or the deadline, appending any
      // delegation facts (050) that arrive along the way
      const awaitDecision = async (deadlineMs: number): Promise<boolean> => {
        let remaining = deadlineMs;
        for (;;) {
          const legStart = Date.now(); // deterministic workflow time
          const woke = await condition(
            () => pendingDecision !== undefined || pendingDelegation !== undefined,
            remaining,
          );
          if (!woke) return false;
          if (pendingDecision !== undefined) return true;
          const delegation = pendingDelegation!;
          pendingDelegation = undefined;
          const recorded = await recordDelegation({
            runId,
            expectedVersion: version,
            toPrincipal: delegation.toPrincipal,
            by: delegation.by,
            agent: input.agent,
          });
          version = recorded.version;
          remaining -= Date.now() - legStart;
          if (remaining <= 0) return pendingDecision !== undefined;
        }
      };

      let signalled: boolean;
      const escalation = input.escalation;
      if (escalation !== undefined && escalation.afterMs > 0 && escalation.afterMs < approvalTtlMs) {
        signalled = await awaitDecision(escalation.afterMs);
        if (!signalled) {
          const escalated = await recordEscalation({
            runId,
            expectedVersion: version,
            toGroup: escalation.toGroup,
            agent: input.agent,
          });
          version = escalated.version;
          signalled = await awaitDecision(approvalTtlMs - escalation.afterMs);
        }
      } else {
        signalled = await awaitDecision(approvalTtlMs);
      }
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
        // ticket 064: a switch tripped while the run was paused (a per-run
        // cancel, or any wider kill) beats the approval — the lever wins
        // over the inbox, and the approved write never executes.
        const resumeLimits = await checkLimits({ agent: input.agent, runId, phase: "step" });
        if (!resumeLimits.ok) {
          const failed = await recordBudgetFailure({
            runId,
            expectedVersion: version,
            reason: resumeLimits.reason,
            detail: resumeLimits.detail,
          });
          return {
            outcome: "budget_exceeded",
            reason: resumeLimits.reason,
            version: failed.version,
            steps: usage.stepCount,
          };
        }
        const executed = await executeApprovedIntent({
          runId,
          expectedVersion: version,
          agent: input.agent,
          principal: input.principal,
          tool: model.tool,
          args: model.args,
          ...(delegation !== undefined ? { delegation } : {}),
        });
        version = executed.version;
      }
    }
  }
}
