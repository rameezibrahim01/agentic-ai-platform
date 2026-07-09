// RBAC roles (architecture §3). Phase 1 floor: the roles exist and gate the
// console; the permission table grows in Phase 2 (approvals, grants).
export const ROLES = [
  "platform_admin",
  "agent_developer",
  "approver",
  "auditor",
  "viewer",
] as const;

export type Role = (typeof ROLES)[number];

export type Action = "view_runs" | "manage_platform" | "approve_intents";

const PERMISSIONS: Record<Action, readonly Role[]> = {
  view_runs: ROLES,
  manage_platform: ["platform_admin"],
  approve_intents: ["approver", "platform_admin"],
};

/** Deny by default: unknown actions (runtime strings) are never permitted. */
export function can(roles: readonly Role[], action: Action): boolean {
  const allowed = PERMISSIONS[action] as readonly Role[] | undefined;
  if (allowed === undefined) return false;
  return roles.some((role) => allowed.includes(role));
}
