import type { PolicyDecision, RiskTier } from "@platform/core";

// Policy is code, not tribal knowledge (architecture §8): declarative rules,
// first match wins, and the decision is recorded WITH the rule that fired —
// that is what turns an audit from archaeology into a query. Deliberately
// fewer than ten rules to start; the rule shape is kept swappable for a
// Cedar/OPA-class engine later.

export interface PolicyContext {
  agent: string;
  principal: string;
  tool: { name: string; version: string; risk: RiskTier };
  env: string;
  /** Digest of the intent arguments — recorded, not matched on, in Phase 2. */
  argsDigest?: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  /** All present fields must match; absent fields match anything. */
  match: {
    env?: string;
    agent?: string;
    tool?: string;
    toolVersion?: string;
    risk?: readonly RiskTier[];
  };
  decision: PolicyDecision;
}

export interface PolicyResult {
  decision: PolicyDecision;
  /** Maps directly onto PolicyEvaluated.rule in the event log. */
  ruleId: string;
}

/** The absence of policy is never permission. */
export const DEFAULT_DENY_RULE_ID = "default-deny";

function ruleMatches(rule: PolicyRule, context: PolicyContext): boolean {
  const { match } = rule;
  if (match.env !== undefined && match.env !== context.env) return false;
  if (match.agent !== undefined && match.agent !== context.agent) return false;
  if (match.tool !== undefined && match.tool !== context.tool.name) return false;
  if (match.toolVersion !== undefined && match.toolVersion !== context.tool.version) return false;
  if (match.risk !== undefined && !match.risk.includes(context.tool.risk)) return false;
  return true;
}

/** Pure and total: first matching rule wins; no match → default-deny. */
export function evaluatePolicy(
  context: PolicyContext,
  rules: readonly PolicyRule[],
): PolicyResult {
  for (const rule of rules) {
    if (ruleMatches(rule, context)) {
      return { decision: rule.decision, ruleId: rule.id };
    }
  }
  return { decision: "deny", ruleId: DEFAULT_DENY_RULE_ID };
}

/**
 * The architecture §6 default posture, in four rules: reads auto-execute;
 * writes auto-execute in dev but require approval elsewhere until an agent
 * earns trust; irreversible and financial actions always require approval.
 */
export const DEFAULT_RULES: readonly PolicyRule[] = [
  {
    id: "irreversible-financial-always-approve",
    description: "irreversible and financial actions always require approval",
    match: { risk: ["irreversible", "financial"] },
    decision: "require_approval",
  },
  {
    id: "read-auto-allow",
    description: "reads auto-execute everywhere",
    match: { risk: ["read"] },
    decision: "allow",
  },
  {
    id: "write-dev-auto-allow",
    description: "writes auto-execute (with logging) in dev",
    match: { env: "dev", risk: ["write"] },
    decision: "allow",
  },
  {
    id: "write-requires-approval",
    description: "writes require approval outside dev until the agent earns trust",
    match: { risk: ["write"] },
    decision: "require_approval",
  },
];
