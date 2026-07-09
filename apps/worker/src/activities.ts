import type { RunEvent } from "@platform/core";
import type { EventStore } from "@platform/storage";
import { idempotentAppend } from "./append.js";

// Stub activities (ticket 003): scripted values, no real providers. Real model
// and tool calls arrive via @platform/model-gateway in tickets 004/005+.
// Timestamps are produced HERE, never in workflow code (determinism rule).

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
  step: number;
  /** Scripted behavior: intents for `scriptSteps` steps, then completion. */
  scriptSteps: number;
}

export type CallModelResponse =
  | { kind: "tool_intent"; version: number; tool: string; args: Record<string, unknown> }
  | { kind: "completed"; version: number };

export interface ExecuteToolRequest {
  runId: string;
  expectedVersion: number;
  tool: string;
  args: Record<string, unknown>;
}

export interface ExecuteToolResponse {
  version: number;
}

function fail(error: string): never {
  throw new Error(error);
}

export function createActivities(store: EventStore) {
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
      const { runId, expectedVersion, step, scriptSteps } = request;
      const done = step >= scriptSteps;
      const event: RunEvent = done
        ? {
            type: "RunCompleted",
            runId,
            seq: expectedVersion,
            at: Date.now(),
            outcome: `scripted completion after ${step} steps`,
            totalCostUsd: 0.001 * step,
            steps: step,
          }
        : {
            type: "ModelCalled",
            runId,
            seq: expectedVersion,
            at: Date.now(),
            gatewayReqId: `stub-${runId}-${expectedVersion}`,
            model: "stub-model",
            tokensIn: 100 + step,
            tokensOut: 40 + step,
            costUsd: 0.001,
          };
      const result = await idempotentAppend(store, runId, expectedVersion, [event]);
      if (!result.ok) fail(result.error);
      return done
        ? { kind: "completed", version: result.version }
        : {
            kind: "tool_intent",
            version: result.version,
            tool: "stub.lookup",
            args: { step },
          };
    },

    async executeTool(request: ExecuteToolRequest): Promise<ExecuteToolResponse> {
      const { runId, expectedVersion, tool, args } = request;
      const at = Date.now();
      // One atomic append: intent → policy(allow) → executed, the read-only
      // Phase 1 shape. The real policy engine arrives in Phase 2.
      const events: RunEvent[] = [
        { type: "ToolIntentEmitted", runId, seq: expectedVersion, at, tool, args, risk: "read" },
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
  };
}

export type Activities = ReturnType<typeof createActivities>;
