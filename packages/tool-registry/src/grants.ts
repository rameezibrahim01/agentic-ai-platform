import { refKey, type ToolRef } from "./registry.js";

// Grants are exact name@version — no wildcards in Phase 2. "Developer in the
// workspace" never silently means "may fire the refund agent" (architecture §3).

export interface AgentGrants {
  agent: string;
  tools: ToolRef[];
}

export function hasGrant(
  grants: readonly AgentGrants[],
  agent: string,
  ref: ToolRef,
): boolean {
  const key = refKey(ref);
  return grants.some(
    (grant) => grant.agent === agent && grant.tools.some((tool) => refKey(tool) === key),
  );
}
