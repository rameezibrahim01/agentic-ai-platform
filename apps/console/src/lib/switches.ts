import { z } from "zod";
import { can } from "@platform/auth";
import type { SessionClaims } from "@platform/auth";
import type { OpsAuditStore } from "@platform/storage";

// Kill-switch write path (ticket 047). The limits FILE stays the single
// source of truth — the worker's mtime loader is untouched; the console
// gains exactly ONE write action: flip a switch, gated by role and session
// scope, and recorded in ops_audit. Refused flips are audited too — the
// gateway's refuse-and-audit doctrine, applied to operators.

// Same shape as the worker's limitsConfigSchema (apps/worker/src/limits.ts),
// duplicated so the worker package never enters the Next bundle. A malformed
// current file REFUSES the flip — the emergency lever never "fixes" config.
export const consoleLimitsSchema = z
  .object({
    killSwitches: z
      .object({
        global: z.boolean().default(false),
        agents: z.record(z.boolean()).default({}),
      })
      .strict()
      .default({ global: false, agents: {} }),
    budgetCaps: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
        maxWallMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    rateLimits: z
      .object({ runsPerHourPerAgent: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();

export type ConsoleLimits = z.infer<typeof consoleLimitsSchema>;

export type FlipRequest =
  | { scope: "global"; tripped: boolean }
  | { scope: "agent"; agent: string; tripped: boolean };

export type FlipResult =
  | { ok: true; config: ConsoleLimits; from: boolean; to: boolean }
  | { ok: false; error: string };

export function flipSwitch(rawCurrent: unknown, flip: FlipRequest): FlipResult {
  const parsed = consoleLimitsSchema.safeParse(rawCurrent);
  if (!parsed.success) {
    return { ok: false, error: "the current limits file is malformed — refusing to flip (fix the file first)" };
  }
  const config = parsed.data;
  if (flip.scope === "global") {
    const from = config.killSwitches.global;
    return {
      ok: true,
      config: { ...config, killSwitches: { ...config.killSwitches, global: flip.tripped } },
      from,
      to: flip.tripped,
    };
  }
  if (!flip.agent) return { ok: false, error: "agent scope requires an agent id" };
  const from = config.killSwitches.agents[flip.agent] === true;
  return {
    ok: true,
    config: {
      ...config,
      killSwitches: {
        ...config.killSwitches,
        agents: { ...config.killSwitches.agents, [flip.agent]: flip.tripped },
      },
    },
    from,
    to: flip.tripped,
  };
}

export type WriteTarget =
  | { ok: true; target: "shared" | { tenant: string } }
  | { ok: false; reason: "forbidden" | "cross_tenant" | "tenant_param_untenanted" };

/**
 * Which limits file may THIS session flip: an untenanted-deployment admin →
 * the shared file; a tenant-bound admin → their own lane's file, never
 * another's; the 042 operator (untenanted admin in a tenanted deployment)
 * → the shared file, or a lane it explicitly names. Everyone else: refused.
 */
export function switchWriteTarget(
  session: Pick<SessionClaims, "roles" | "tenant">,
  tenanted: boolean,
  requestedTenant: string | undefined,
): WriteTarget {
  if (!can(session.roles, "manage_platform")) return { ok: false, reason: "forbidden" };
  if (!tenanted) {
    if (requestedTenant !== undefined) return { ok: false, reason: "tenant_param_untenanted" };
    return { ok: true, target: "shared" };
  }
  if (session.tenant !== undefined) {
    if (requestedTenant !== undefined && requestedTenant !== session.tenant) {
      return { ok: false, reason: "cross_tenant" };
    }
    return { ok: true, target: { tenant: session.tenant } };
  }
  // operator identity (042)
  return {
    ok: true,
    target: requestedTenant !== undefined ? { tenant: requestedTenant } : "shared",
  };
}

export interface FlipDeps {
  session: Pick<SessionClaims, "roles" | "tenant" | "principal">;
  tenanted: boolean;
  /** LIMITS_CONFIG; undefined = no limits mounted, flips impossible. */
  sharedPath: string | undefined;
  /** Resolve a target to its file path (shared path or the lane file beside it). */
  pathFor(target: "shared" | { tenant: string }): string;
  /** null = file does not exist. */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  audit: OpsAuditStore;
  nowMs(): number;
}

export interface FlipResponse {
  status: 200 | 400 | 403 | 409;
  body: Record<string, unknown>;
}

/** The whole write path, pure over injected deps — the route is an adapter. */
export async function handleSwitchFlip(
  deps: FlipDeps,
  request: FlipRequest & { tenant?: string },
): Promise<FlipResponse> {
  const scopeLabel = (target: "shared" | { tenant: string }): string =>
    target === "shared" ? "shared" : `tenant:${target.tenant}`;

  const admitted = switchWriteTarget(deps.session, deps.tenanted, request.tenant);
  if (!admitted.ok) {
    // refusals are audited too — silence around a refused emergency action
    // is its own audit hole
    await deps.audit.record({
      at: deps.nowMs(),
      principal: deps.session.principal,
      action: "kill_switch_flip_refused",
      scope: request.tenant !== undefined ? `tenant:${request.tenant}` : "shared",
      detail: { reason: admitted.reason, request: { ...request } },
    });
    return { status: 403, body: { error: `flip refused: ${admitted.reason}` } };
  }
  if (deps.sharedPath === undefined) {
    return { status: 409, body: { error: "no LIMITS_CONFIG mounted — there is nothing to flip" } };
  }

  const path = deps.pathFor(admitted.target);
  let raw = await deps.readFile(path);
  if (raw === null && admitted.target !== "shared") {
    // a lane file that is not mounted cannot be created from a container —
    // refuse with instructions instead of writing somewhere the worker
    // will never read
    return {
      status: 409,
      body: {
        error: `limits file for ${scopeLabel(admitted.target)} is not present — create/mount it beside the shared file first`,
      },
    };
  }
  if (raw === null) {
    return { status: 409, body: { error: "the shared limits file is missing" } };
  }

  let current: unknown;
  try {
    current = JSON.parse(raw);
  } catch {
    return { status: 409, body: { error: "the limits file is not valid JSON — refusing to flip" } };
  }
  const flipped = flipSwitch(current, request);
  if (!flipped.ok) return { status: 400, body: { error: flipped.error } };

  await deps.writeFile(path, `${JSON.stringify(flipped.config, null, 2)}\n`);
  await deps.audit.record({
    at: deps.nowMs(),
    principal: deps.session.principal,
    action: "kill_switch_flip",
    scope: scopeLabel(admitted.target),
    detail: {
      switch: request.scope === "global" ? "global" : `agent:${request.agent}`,
      from: flipped.from,
      to: flipped.to,
      file: path,
    },
  });
  return {
    status: 200,
    body: { ok: true, scope: scopeLabel(admitted.target), from: flipped.from, to: flipped.to },
  };
}
