import type { ZodIssue } from "zod";
import type {
  PolicyEvaluated,
  ToolExecuted,
  ToolFailed,
  ToolIntentEmitted,
} from "@platform/core";
import { delegationCovers, verifyDelegation } from "@platform/identity";
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

/** Request identity handed to executors (ticket 021) — audit-relevant fields
 * only, never the credential itself. */
export interface ExecutionContext {
  runId: string;
  agent: string;
  principal: string;
}

export interface ToolExecutor {
  ref: ToolRef;
  execute(
    args: unknown,
    secrets: Readonly<Record<string, string>>,
    context: ExecutionContext,
  ): Promise<unknown>;
}

export interface IntentRequest {
  runId: string;
  agent: string;
  principal: string;
  intent: { tool: string; version: string; args: Record<string, unknown> };
  /** Delegated credential for runs acting for a user (ticket 019). */
  delegation?: string;
}

// Event payloads ready for the log — the engine adds { runId, seq, at }.
export type ToolIntentPayload = Omit<ToolIntentEmitted, "type" | "runId" | "seq" | "at">;
export type PolicyEvaluatedPayload = Omit<PolicyEvaluated, "type" | "runId" | "seq" | "at">;
export type ToolExecutedPayload = Omit<ToolExecuted, "type" | "runId" | "seq" | "at">;

export const RESULT_PREVIEW_CAP = 2_000;

/** Ticket 063: the capped human excerpt of a tool result. Cap counts CODE
 * POINTS (never splits a surrogate pair); null/undefined results yield no
 * preview at all — absence, not an empty string. */
export function resultPreviewOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) return undefined;
  const points = Array.from(serialized);
  return points.length > RESULT_PREVIEW_CAP
    ? `${points.slice(0, RESULT_PREVIEW_CAP - 1).join("")}…`
    : serialized;
}
export type ToolFailedPayload = Omit<ToolFailed, "type" | "runId" | "seq" | "at">;

export type RefusalReason =
  | { code: "delegation_missing"; ref: string }
  | { code: "delegation_invalid"; reason: "malformed" | "tampered" | "expired" }
  | { code: "delegation_out_of_scope"; detail: string }
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
  /** When required, every intent must carry a covering delegation (ticket 019). */
  delegation?: { required: boolean; secret: string };
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

    // Every refusal is audit-ready: pre-policy refusals carry the intent
    // (unknown tools audited at the most severe tier — unknown capability is
    // assumed worst) and a synthetic deny decision `gateway:<code>`, so the
    // engine can append a reducer-legal Intent → PolicyEvaluated(deny) pair.
    const lookedUp = options.registry.get(ref);
    const auditIntent: ToolIntentPayload = {
      tool: toolId,
      args: request.intent.args,
      risk: lookedUp.ok ? lookedUp.contract.risk : "irreversible",
    };
    const gatewayDeny = (code: string): PolicyEvaluatedPayload => ({
      decision: "deny",
      rule: `gateway:${code}`,
    });

    // (0) delegation — when required, the credential gates everything else:
    // it must verify, belong to this principal+agent, and cover exactly this
    // tool at this risk (unknown tools rate the worst tier, so a delegation
    // that doesn't explicitly include "irreversible" can never reach them).
    if (options.delegation?.required) {
      if (request.delegation === undefined) {
        return refuse(
          { code: "delegation_missing", ref: toolId },
          { intent: auditIntent, policy: gatewayDeny("delegation_missing") },
        );
      }
      const verified = verifyDelegation(request.delegation, options.delegation.secret, nowMs());
      if (!verified.ok) {
        return refuse(
          { code: "delegation_invalid", reason: verified.reason },
          { intent: auditIntent, policy: gatewayDeny("delegation_invalid") },
        );
      }
      if (
        verified.claims.principal !== request.principal ||
        verified.claims.agent !== request.agent ||
        verified.claims.env !== options.env
      ) {
        return refuse(
          { code: "delegation_out_of_scope", detail: "principal/agent/env mismatch" },
          { intent: auditIntent, policy: gatewayDeny("delegation_out_of_scope") },
        );
      }
      if (!delegationCovers(verified.claims, ref, auditIntent.risk)) {
        return refuse(
          {
            code: "delegation_out_of_scope",
            detail: `delegation does not cover ${toolId} at risk ${auditIntent.risk}`,
          },
          { intent: auditIntent, policy: gatewayDeny("delegation_out_of_scope") },
        );
      }
    }

    // (a) grant — refused no matter what the model asked for; unknown tools
    // are indistinguishable from ungranted ones to the model (no probing).
    if (!hasGrant(options.grants, request.agent, ref)) {
      return refuse(
        { code: "not_granted", ref: toolId },
        { intent: auditIntent, policy: gatewayDeny("not_granted") },
      );
    }
    if (!lookedUp.ok) {
      return refuse(
        { code: "tool_not_found", ref: toolId },
        { intent: auditIntent, policy: gatewayDeny("tool_not_found") },
      );
    }
    const contract = lookedUp.contract;
    const intent = auditIntent;

    // (b) input validation — malformed intents never reach systems
    const input = options.registry.validateInput(ref, request.intent.args);
    if (!input.ok) {
      const issues = "issues" in input.error ? input.error.issues : [];
      return refuse(
        { code: "invalid_input", issues },
        { intent, policy: gatewayDeny("invalid_input") },
      );
    }

    // (c) egress — every declared host must be allowlisted for this env
    const blockedHosts = contract.egress.filter((h) => !options.egressAllowlist.includes(h));
    if (blockedHosts.length > 0) {
      return refuse(
        { code: "egress_denied", hosts: blockedHosts },
        { intent, policy: gatewayDeny("egress_denied") },
      );
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
      rawResult = await executor.execute(input.value, options.secrets?.[toolId] ?? {}, {
        runId: request.runId,
        agent: request.agent,
        principal: request.principal,
      });
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

    const preview = resultPreviewOf(output.value);
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
          ...(preview !== undefined ? { resultPreview: preview } : {}),
        },
      },
    };
  }

  return {
    handleIntent: (request) => run(request, true),
    executeApproved: (request) => run(request, false),
  };
}
