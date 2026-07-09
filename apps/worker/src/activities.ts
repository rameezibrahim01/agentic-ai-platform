import type { Tracer } from "@opentelemetry/api";
import type { BudgetExceededReason, RiskTier, RunEvent } from "@platform/core";
import type { EventStore } from "@platform/storage";
import type { ModelGateway, Usage } from "@platform/model-gateway";
import { emitRunTrace } from "@platform/telemetry";
import { idempotentAppend } from "./append.js";

// Activities own all I/O and timestamps (determinism rule from ticket 003).
// Since ticket 005 the model path goes through @platform/model-gateway —
// gateway usage feeds token/cost totals via the reducer, no separate
// accounting (CLAUDE.md #7). Tests script behavior with FakeProvider.

export interface WorkerDeps {
  store: EventStore;
  gateway: ModelGateway;
  /** Optional (ticket 008): terminal activities emit the run's trace, derived
   *  from the event log. Omitted → tracing is skipped entirely. */
  tracer?: Tracer;
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
      risk: RiskTier;
      usage: Usage;
      costUsd: number;
    }
  | { kind: "message"; version: number; content: string; usage: Usage; costUsd: number };

export interface ExecuteToolRequest {
  runId: string;
  expectedVersion: number;
  tool: string;
  args: Record<string, unknown>;
  risk: RiskTier;
}

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

export function createActivities({ store, gateway, tracer }: WorkerDeps) {
  // One trace per run, emitted once when the run reaches a terminal event
  // (deduped retries do not re-emit).
  async function emitTerminalTrace(runId: string): Promise<void> {
    if (!tracer) return;
    const loaded = await store.load(runId);
    if (loaded) emitRunTrace(tracer, loaded.events);
  }

  return {
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
            risk: completion.intent.risk,
            usage: completion.usage,
            costUsd: completion.costUsd,
          };
    },

    async executeTool(request: ExecuteToolRequest): Promise<{ version: number }> {
      const { runId, expectedVersion, tool, args, risk } = request;
      const at = Date.now();
      // One atomic append: intent → policy(allow) → executed, the read-only
      // Phase 1 shape. The real policy engine arrives in Phase 2.
      const events: RunEvent[] = [
        { type: "ToolIntentEmitted", runId, seq: expectedVersion, at, tool, args, risk },
        {
          type: "PolicyEvaluated",
          runId,
          seq: expectedVersion + 1,
          at,
          decision: "allow",
          rule: "phase1-read-only-auto-allow",
        },
        {
          type: "ToolExecuted",
          runId,
          seq: expectedVersion + 2,
          at,
          gatewayReqId: `stub-${runId}-${expectedVersion}`,
          resultDigest: `digest-${expectedVersion}`,
          latencyMs: 1,
        },
      ];
      const result = await idempotentAppend(store, runId, expectedVersion, events);
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
