import type { ZodIssue } from "zod";
import type {
  PolicyEvaluated,
  ToolExecuted,
  ToolFailed,
  ToolIntentEmitted,
} from "@platform/core";
import { evaluatePolicy } from "@platform/policy";
import type { PolicyResult, PolicyRule } from "@platform/policy";
import { hasGrant, refKey, ToolRegistry } from "@platform/tool-registry";
import type { AgentGrants, ToolRef } from "@platform/tool-registry";
import { digestOf } from "./digest.js";

// The tool gateway (architecture §6) — where safety actually lives. The model
// emits INTENTS; this pipeline decides. Every step is a typed refusal on
// failure, every outcome carries audit-ready event payloads (refusals
// included: the ATTEMPT is always auditable), and secrets are injected
// server-side — they exist only between the gateway and the executor
// (CLAUDE.md #2, #4).

export interface ToolExecutor {
  ref: ToolRef;
  execute(args: unknown, secrets: Readonly<Record<string, string>>): Promise<unknown>;
}

export interface IntentRequest {
  runId: string;
  agent: string;
  principal: string;
  intent: { tool: string; version: string; args: Record<string, unknown> };
}

// Event payloads ready for the log — the engine adds { runId, seq, at }.
export type ToolIntentPayload = Omit<ToolIntentEmitted, "type" | "runId" | "seq" | "at">;
export type PolicyEvaluatedPayload = Omit<PolicyEvaluated, "type" | "runId" | "seq" | "at">;
export type ToolExecutedPayload = Omit<ToolExecuted, "type" | "runId" | "seq" | "at">;
export type ToolFailedPayload = Omit<ToolFailed, "type" | "runId" | "seq" | "at">;

export type RefusalReason =
  | { code: "not_granted"; ref: string }
  | { code: "tool_not_found"; ref: string }
  | { code: "invalid_input"; issues: ZodIssue[] }
  | { code: "egress_denied"; hosts: string[] }
  | { code: "policy_denied"; ruleId: string }
  | { code: "no_executor"; ref: string }
  | { code: "execution_failed"; error: string }
  | { code: "invalid_output"; issues: ZodIssue[] };

export type IntentOutcome =
  | {
      kind: "executed";
      result: unknown;
      audit: {
        intent: ToolIntentPayload;
        policy: PolicyEvaluatedPayload;
        executed: ToolExecutedPayload;
      };
    }
  | {
      kind: "approval_required";
      policy: PolicyResult;
      audit: { intent: ToolIntentPayload; policy: PolicyEvaluatedPayload };
    }
  | {
      kind: "refused";
      reason: RefusalReason;
      audit: {
        intent?: ToolIntentPayload;
        policy?: PolicyEvaluatedPayload;
        failed: ToolFailedPayload;
      };
    };

export interface ToolGatewayOptions {
  registry: ToolRegistry;
  grants: readonly AgentGrants[];
  rules: readonly PolicyRule[];
  executors: readonly ToolExecutor[];
  /** Hosts this environment permits tools to reach. */
  egressAllowlist: readonly string[];
  /** Server-side secrets per name@version — never present in intents/events. */
  secrets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  env: string;
  makeReqId?: () => string;
  nowMs?: () => number;
}

export interface ToolGateway {
  /** Full pipeline: grant → input → egress → policy → execute → output. */
  handleIntent(request: IntentRequest): Promise<IntentOutcome>;
  /** Post-approval execution: policy step skipped (already decided by a human). */
  executeApproved(request: IntentRequest): Promise<IntentOutcome>;
}

export function createToolGateway(options: ToolGatewayOptions): ToolGateway {
  const executorsByRef = new Map(options.executors.map((e) => [refKey(e.ref), e]));
  let reqCounter = 0;
  const makeReqId = options.makeReqId ?? (() => `tg-${++reqCounter}`);
  const nowMs = options.nowMs ?? (() => Date.now());

  const refuse = (
    reason: RefusalReason,
    audit: { intent?: ToolIntentPayload; policy?: PolicyEvaluatedPayload },
  ): IntentOutcome => ({
    kind: "refused",
    reason,
    audit: {
      ...audit,
      failed: { error: `${reason.code}: ${JSON.stringify(reason)}`, retryable: false },
    },
  });

  async function run(request: IntentRequest, withPolicy: boolean): Promise<IntentOutcome> {
    const ref: ToolRef = { name: request.intent.tool, version: request.intent.version };
    const toolId = refKey(ref);

    // (a) grant — refused no matter what the model asked for; unknown tools
    // are indistinguishable from ungranted ones to the model (no probing).
    if (!hasGrant(options.grants, request.agent, ref)) {
      return refuse({ code: "not_granted", ref: toolId }, {});
    }
    const found = options.registry.get(ref);
    if (!found.ok) {
      return refuse({ code: "tool_not_found", ref: toolId }, {});
    }
    const contract = found.contract;
    const intent: ToolIntentPayload = {
      tool: toolId,
      args: request.intent.args,
      risk: contract.risk,
    };

    // (b) input validation — malformed intents never reach systems
    const input = options.registry.validateInput(ref, request.intent.args);
    if (!input.ok) {
      const issues = "issues" in input.error ? input.error.issues : [];
      return refuse({ code: "invalid_input", issues }, { intent });
    }

    // (c) egress — every declared host must be allowlisted for this env
    const blockedHosts = contract.egress.filter((h) => !options.egressAllowlist.includes(h));
    if (blockedHosts.length > 0) {
      return refuse({ code: "egress_denied", hosts: blockedHosts }, { intent });
    }

    // (d) policy — with full context; the decision and rule are recorded
    let policy: PolicyEvaluatedPayload;
    if (withPolicy) {
      const result = evaluatePolicy(
        {
          agent: request.agent,
          principal: request.principal,
          tool: { name: contract.name, version: contract.version, risk: contract.risk },
          env: options.env,
          argsDigest: digestOf(request.intent.args),
        },
        options.rules,
      );
      policy = { decision: result.decision, rule: result.ruleId };
      if (result.decision === "deny") {
        return refuse({ code: "policy_denied", ruleId: result.ruleId }, { intent, policy });
      }
      if (result.decision === "require_approval") {
        return { kind: "approval_required", policy: result, audit: { intent, policy } };
      }
    } else {
      policy = { decision: "allow", rule: "approved-by-human" };
    }

    // (e) execute — secrets injected server-side, never present in any payload
    const executor = executorsByRef.get(toolId);
    if (executor === undefined) {
      return refuse({ code: "no_executor", ref: toolId }, { intent, policy });
    }
    const startedAt = nowMs();
    let rawResult: unknown;
    try {
      rawResult = await executor.execute(input.value, options.secrets?.[toolId] ?? {});
    } catch (error) {
      return refuse(
        {
          code: "execution_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        { intent, policy },
      );
    }

    // (f) output validation — malformed results never pass unlabeled
    const output = options.registry.validateOutput(ref, rawResult);
    if (!output.ok) {
      const issues = "issues" in output.error ? output.error.issues : [];
      return refuse({ code: "invalid_output", issues }, { intent, policy });
    }

    return {
      kind: "executed",
      result: output.value,
      audit: {
        intent,
        policy,
        executed: {
          gatewayReqId: makeReqId(),
          resultDigest: digestOf(output.value),
          latencyMs: Math.max(0, nowMs() - startedAt),
        },
      },
    };
  }

  return {
    handleIntent: (request) => run(request, true),
    executeApproved: (request) => run(request, false),
  };
}
