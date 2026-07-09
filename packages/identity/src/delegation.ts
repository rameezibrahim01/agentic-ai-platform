import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { riskTierSchema } from "@platform/core";
import type { RiskTier } from "@platform/core";
import { refKey } from "@platform/tool-registry";
import type { ToolRef } from "@platform/tool-registry";

// Delegated, scoped, time-boxed credentials (architecture §7): no agent ever
// holds a credential broader than the single action it is about to take.
// Within the platform boundary the delegation is an HMAC-signed token — the
// OAuth token-exchange shape federates this in Phase 4; the invariants
// (named tools, risk ceiling, mandatory expiry) are identical and tested now.
// Pure apart from crypto: the clock is injected, same discipline as sessions.

/** Distinct workload identity per agent per environment (SPIFFE-style). */
export function workloadIdentityFor(agent: string, env: string): string {
  return `platform://agent/${agent}/${env}`;
}

const toolRefSchema = z
  .object({ name: z.string().min(1), version: z.string().min(1) })
  .strict();

const delegationClaimsSchema = z
  .object({
    principal: z.string().min(1),
    agent: z.string().min(1),
    env: z.string().min(1),
    /** The workload identity the token was minted for. */
    presenter: z.string().min(1),
    runId: z.string().min(1).optional(),
    tools: z.array(toolRefSchema).min(1),
    risks: z.array(riskTierSchema).min(1),
    /** epoch ms UTC */
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type DelegationClaims = z.infer<typeof delegationClaimsSchema>;

export interface DelegationScope {
  principal: string;
  agent: string;
  env: string;
  runId?: string;
  tools: ToolRef[];
  risks: RiskTier[];
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintDelegation(
  scope: DelegationScope,
  ttlMs: number,
  secret: string,
  nowMs: number,
): string {
  const claims: DelegationClaims = {
    principal: scope.principal,
    agent: scope.agent,
    env: scope.env,
    presenter: workloadIdentityFor(scope.agent, scope.env),
    ...(scope.runId !== undefined ? { runId: scope.runId } : {}),
    tools: scope.tools.map((t) => ({ name: t.name, version: t.version })),
    risks: [...scope.risks],
    exp: nowMs + ttlMs,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export type DelegationVerification =
  | { ok: true; claims: DelegationClaims }
  | { ok: false; reason: "malformed" | "tampered" | "expired" };

export function verifyDelegation(
  token: string,
  secret: string,
  nowMs: number,
): DelegationVerification {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts;
  const expected = sign(payload!, secret);
  const signatureBuf = Buffer.from(signature!, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return { ok: false, reason: "tampered" };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = delegationClaimsSchema.safeParse(claims);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.exp <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed.data };
}

/** Exact tool match AND risk within the delegation's ceiling. */
export function delegationCovers(
  claims: DelegationClaims,
  ref: ToolRef,
  risk: RiskTier,
): boolean {
  const key = refKey(ref);
  return (
    claims.tools.some((tool) => refKey(tool) === key) && claims.risks.includes(risk)
  );
}
