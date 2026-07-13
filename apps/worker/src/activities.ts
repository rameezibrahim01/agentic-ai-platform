import type { Tracer } from "@opentelemetry/api";
import type { BudgetExceededReason, BudgetPolicy, RunEvent } from "@platform/core";
import { exerciseGrant } from "@platform/identity";
import type { GrantExercise, GrantStore } from "@platform/identity";
import type { EventStore } from "@platform/storage";
import { checkKillSwitch, countRecentStarts, NO_LIMITS } from "./limits.js";
import type { LimitsConfig } from "./limits.js";
import type { ModelGateway, Usage } from "@platform/model-gateway";
import type { ToolGateway } from "@platform/tool-gateway";
import { emitRunTrace } from "@platform/telemetry";
import { idempotentAppend } from "./append.js";

// Activities own all I/O and timestamps (determinism rule from ticket 003).
// The model path goes through @platform/model-gateway (005); since ticket 017
// every tool intent goes through @platform/tool-gateway — grant, schema,
// egress, policy, secrets, digests (CLAUDE.md #2). Timestamps are produced
// HERE, never in workflow code.

export interface WorkerDeps {
  store: EventStore;
  gateway: ModelGateway;
  tools: ToolGateway;
  /** Optional (ticket 008): terminal activities emit the run's trace. */
  tracer?: Tracer;
  /** Optional (ticket 020): standing grants for scheduled runs. */
  grants?: {
    store: GrantStore;
    /** Delegation signing secret — the same one the tool gateway verifies with. */
    secret: string;
    env: string;
    /** Per-occurrence delegation ttl; always capped at the grant's expiry. Default 15 min. */
    ttlMs?: number;
  };
  /** Optional (ticket 033): operator limits, re-read per check so flips are instant. */
  limits?: { load: () => Promise<LimitsConfig> };
}

export interface StartRunRequest {
  runId: string;
  agent: string;
  principal: string;
  input: unknown;
}

export interface CallModelRequest {
  runId: string;
  /** Current log length; doubles as the seq of the event this call appends. */
  expectedVersion: number;
  model: string;
  prompt: string;
}

export type CallModelResponse =
  | {
      kind: "tool_intent";
      version: number;
      tool: string;
      args: Record<string, unknown>;
      usage: Usage;
      costUsd: number;
    }
  | { kind: "message"; version: number; content: string; usage: Usage; costUsd: number };

export interface ResolveIntentRequest {
  runId: string;
  expectedVersion: number;
  agent: string;
  principal: string;
  /** "name@version"; a bare name defaults to v1. */
  tool: string;
  args: Record<string, unknown>;
  approverGroup: string;
  approvalTtlMs: number;
  /** Delegated credential, threaded untouched (ticket 019). */
  delegation?: string;
}

export type ResolveIntentResponse =
  | { kind: "executed"; version: number }
  | { kind: "approval_required"; version: number; expiresAt: number }
  | { kind: "refused"; version: number; reason: string };

export interface RecordEscalationRequest {
  runId: string;
  expectedVersion: number;
  toGroup: string;
}

export interface ApprovalDecisionRequest {
  runId: string;
  expectedVersion: number;
  granted: boolean;
  by: string;
  comment?: string;
}

export interface ExecuteApprovedRequest {
  runId: string;
  expectedVersion: number;
  agent: string;
  principal: string;
  tool: string;
  args: Record<string, unknown>;
  delegation?: string;
}

export interface CheckLimitsRequest {
  agent: string;
  /** "start" also enforces the rate limit; "step" is the kill-switch check. */
  phase: "start" | "step";
}

export type CheckLimitsResponse =
  | { ok: true; budgetCaps?: BudgetPolicy }
  | { ok: false; reason: "KilledBySwitch" | "RateLimited"; detail: string };

export interface ResolveStandingGrantRequest {
  grantId: string;
  runId: string;
  agent: string;
}

export type ResolveStandingGrantResponse =
  | { ok: true; delegation: string; exercise: GrantExercise }
  | { ok: false; reason: "grants_not_configured" | "not_found" | "revoked" | "expired" };

export interface CompleteRunRequest {
  runId: string;
  expectedVersion: number;
  outcome: string;
  totalCostUsd: number;
  steps: number;
}

export interface RecordBudgetFailureRequest {
  runId: string;
  expectedVersion: number;
  reason: BudgetExceededReason;
  detail: string;
}

function fail(error: string): never {
  throw new Error(error);
}

export function parseToolId(tool: string): { name: string; version: string } {
  const at = tool.lastIndexOf("@");
  if (at <= 0) return { name: tool, version: "v1" };
  return { name: tool.slice(0, at), version: tool.slice(at + 1) };
}

export function createActivities({ store, gateway, tools, tracer, grants, limits }: WorkerDeps) {
  // One trace per run, emitted once when the run reaches a terminal event
  // (deduped retries do not re-emit).
  async function emitTerminalTrace(runId: string): Promise<void> {
    if (!tracer) return;
    const loaded = await store.load(runId);
    if (loaded) emitRunTrace(tracer, loaded.events);
  }

  return {
    /**
     * Operator limits (ticket 033), engine-enforced: kill switches at run
     * start AND before every step (a flipped switch stops in-flight runs at
     * their next step); the rate limit counts RunStarted events in the log —
     * the audit trail is the counter. Config re-reads per call, so flipping
     * the mounted file takes effect in seconds without a restart.
     */
    async checkLimits(request: CheckLimitsRequest): Promise<CheckLimitsResponse> {
      const config = limits === undefined ? NO_LIMITS : await limits.load();
      const switchCheck = checkKillSwitch(config, request.agent);
      if (switchCheck.tripped) {
        return { ok: false, reason: "KilledBySwitch", detail: switchCheck.detail };
      }
      const perHour = config.rateLimits?.runsPerHourPerAgent;
      if (request.phase === "start" && perHour !== undefined) {
        const recent = await countRecentStarts(store, request.agent, Date.now());
        if (recent > perHour) {
          return {
            ok: false,
            reason: "RateLimited",
            detail: `${recent} starts in the last hour exceeds ${perHour}/h for ${request.agent}`,
          };
        }
      }
      return {
        ok: true,
        ...(config.budgetCaps !== undefined ? { budgetCaps: config.budgetCaps } : {}),
      };
    },

    async startRun(request: StartRunRequest): Promise<{ version: number }> {
      const event: RunEvent = {
        type: "RunStarted",
        runId: request.runId,
        seq: 0,
        at: Date.now(),
        agent: request.agent,
        principal: request.principal,
        input: request.input,
      };
      const result = await idempotentAppend(store, request.runId, 0, [event]);
      return result.ok ? { version: result.version } : fail(result.error);
    },

    async callModel(request: CallModelRequest): Promise<CallModelResponse> {
      const { runId, expectedVersion, model, prompt } = request;
      const completion = await gateway.complete({ runId, model, prompt });
      if (!completion.ok) fail(`gateway refused: ${JSON.stringify(completion.error)}`);

      const event: RunEvent = {
        type: "ModelCalled",
        runId,
        seq: expectedVersion,
        at: Date.now(),
        ...completion.modelCalled,
      };
      const result = await idempotentAppend(store, runId, expectedVersion, [event]);
      if (!result.ok) fail(result.error);

      return completion.kind === "message"
        ? {
            kind: "message",
            version: result.version,
            content: completion.content,
            usage: completion.usage,
            costUsd: completion.costUsd,
          }
        : {
            kind: "tool_intent",
            version: result.version,
            tool: completion.intent.tool,
            args: completion.intent.args,
            usage: completion.usage,
            costUsd: completion.costUsd,
          };
    },

    /** Drive the tool gateway; append its audit payloads. All outcomes are auditable. */
    async resolveIntent(request: ResolveIntentRequest): Promise<ResolveIntentResponse> {
      const { runId, expectedVersion } = request;
      const ref = parseToolId(request.tool);
      const outcome = await tools.handleIntent({
        runId,
        agent: request.agent,
        principal: request.principal,
        intent: { tool: ref.name, version: ref.version, args: request.args },
        ...(request.delegation !== undefined ? { delegation: request.delegation } : {}),
      });
      const at = Date.now();
      const base = (seq: number) => ({ runId, seq, at });

      if (outcome.kind === "executed") {
        const events: RunEvent[] = [
          { type: "ToolIntentEmitted", ...base(expectedVersion), ...outcome.audit.intent },
          { type: "PolicyEvaluated", ...base(expectedVersion + 1), ...outcome.audit.policy },
          { type: "ToolExecuted", ...base(expectedVersion + 2), ...outcome.audit.executed },
        ];
        const result = await idempotentAppend(store, runId, expectedVersion, events);
        return result.ok ? { kind: "executed", version: result.version } : fail(result.error);
      }

      if (outcome.kind === "approval_required") {
        const expiresAt = at + request.approvalTtlMs;
        const events: RunEvent[] = [
          { type: "ToolIntentEmitted", ...base(expectedVersion), ...outcome.audit.intent },
          { type: "PolicyEvaluated", ...base(expectedVersion + 1), ...outcome.audit.policy },
          {
            type: "ApprovalRequested",
            ...base(expectedVersion + 2),
            approverGroup: request.approverGroup,
            expiresAt,
          },
        ];
        const result = await idempotentAppend(store, runId, expectedVersion, events);
        return result.ok
          ? { kind: "approval_required", version: result.version, expiresAt }
          : fail(result.error);
      }

      // refused — the attempt is audited. Pre/at-policy refusals carry a deny
      // decision (reducer clears the intent); post-policy failures carry the
      // allow decision followed by ToolFailed.
      const events: RunEvent[] = [];
      let seq = expectedVersion;
      if (outcome.audit.intent) {
        events.push({ type: "ToolIntentEmitted", ...base(seq++), ...outcome.audit.intent });
      }
      if (outcome.audit.policy) {
        events.push({ type: "PolicyEvaluated", ...base(seq++), ...outcome.audit.policy });
        if (outcome.audit.policy.decision === "allow") {
          events.push({ type: "ToolFailed", ...base(seq++), ...outcome.audit.failed });
        }
      }
      const result = await idempotentAppend(store, runId, expectedVersion, events);
      return result.ok
        ? { kind: "refused", version: result.version, reason: outcome.reason.code }
        : fail(result.error);
    },

    /**
     * Resolve a standing grant for a scheduled occurrence (ticket 020). A
     * revoked/expired/missing grant is NOT an activity failure: the run
     * proceeds with NO delegation, so the gateway refuses every governed
     * intent — halting at the policy layer, never falling back to a broader
     * credential.
     */
    async resolveStandingGrant(
      request: ResolveStandingGrantRequest,
    ): Promise<ResolveStandingGrantResponse> {
      if (grants === undefined) return { ok: false, reason: "grants_not_configured" };
      const grant = await grants.store.get(request.grantId);
      if (grant === undefined) return { ok: false, reason: "not_found" };
      const result = exerciseGrant(
        grant,
        { runId: request.runId, agent: request.agent, env: grants.env },
        grants.ttlMs ?? 15 * 60 * 1000,
        grants.secret,
        Date.now(),
      );
      return result.ok
        ? { ok: true, delegation: result.delegation, exercise: result.exercise }
        : { ok: false, reason: result.reason };
    },

    /** Ticket 048: silence at the escalation point becomes a FACT in the log. */
    async recordEscalation(request: RecordEscalationRequest): Promise<{ version: number }> {
      const event: RunEvent = {
        type: "ApprovalEscalated",
        runId: request.runId,
        seq: request.expectedVersion,
        at: Date.now(),
        toGroup: request.toGroup,
      };
      const result = await idempotentAppend(store, request.runId, request.expectedVersion, [event]);
      return result.ok ? { version: result.version } : fail(result.error);
    },

    async recordApprovalDecision(request: ApprovalDecisionRequest): Promise<{ version: number }> {
      const event: RunEvent = request.granted
        ? {
            type: "ApprovalGranted",
            runId: request.runId,
            seq: request.expectedVersion,
            at: Date.now(),
            by: request.by,
            ...(request.comment !== undefined ? { comment: request.comment } : {}),
          }
        : {
            type: "ApprovalDenied",
            runId: request.runId,
            seq: request.expectedVersion,
            at: Date.now(),
            by: request.by,
            ...(request.comment !== undefined ? { comment: request.comment } : {}),
          };
      const result = await idempotentAppend(store, request.runId, request.expectedVersion, [event]);
      return result.ok ? { version: result.version } : fail(result.error);
    },

    /** Post-approval execution: policy already decided by a human; grant/schema/egress still enforced. */
    async executeApprovedIntent(request: ExecuteApprovedRequest): Promise<{ version: number }> {
      const ref = parseToolId(request.tool);
      const outcome = await tools.executeApproved({
        runId: request.runId,
        agent: request.agent,
        principal: request.principal,
        intent: { tool: ref.name, version: ref.version, args: request.args },
        ...(request.delegation !== undefined ? { delegation: request.delegation } : {}),
      });
      const at = Date.now();
      const event: RunEvent =
        outcome.kind === "executed"
          ? {
              type: "ToolExecuted",
              runId: request.runId,
              seq: request.expectedVersion,
              at,
              ...outcome.audit.executed,
            }
          : {
              type: "ToolFailed",
              runId: request.runId,
              seq: request.expectedVersion,
              at,
              error:
                outcome.kind === "refused"
                  ? outcome.audit.failed.error
                  : "approval flow returned an unexpected outcome",
              retryable: false,
            };
      const result = await idempotentAppend(store, request.runId, request.expectedVersion, [event]);
      return result.ok ? { version: result.version } : fail(result.error);
    },

    async completeRun(request: CompleteRunRequest): Promise<{ version: number }> {
      const event: RunEvent = {
        type: "RunCompleted",
        runId: request.runId,
        seq: request.expectedVersion,
        at: Date.now(),
        outcome: request.outcome,
        totalCostUsd: request.totalCostUsd,
        steps: request.steps,
      };
      const result = await idempotentAppend(store, request.runId, request.expectedVersion, [event]);
      if (!result.ok) fail(result.error);
      if (!result.deduped) await emitTerminalTrace(request.runId);
      return { version: result.version };
    },

    /** Engine-side termination: BudgetExceeded then RunFailed, atomically, nothing after. */
    async recordBudgetFailure(request: RecordBudgetFailureRequest): Promise<{ version: number }> {
      const at = Date.now();
      const events: RunEvent[] = [
        {
          type: "BudgetExceeded",
          runId: request.runId,
          seq: request.expectedVersion,
          at,
          reason: request.reason,
          detail: request.detail,
        },
        {
          type: "RunFailed",
          runId: request.runId,
          seq: request.expectedVersion + 1,
          at,
          reason: request.reason,
        },
      ];
      const result = await idempotentAppend(store, request.runId, request.expectedVersion, events);
      if (!result.ok) fail(result.error);
      if (!result.deduped) await emitTerminalTrace(request.runId);
      return { version: result.version };
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
