import { can, type SessionClaims } from "@platform/auth";
import { replay } from "@platform/core";
import type { EventStore } from "@platform/storage";

// Delegation to a person (ticket 050). The decision gate widens exactly one
// notch: the NAMED delegate may decide the run handed to them — and nothing
// else. Delegation itself requires approve_intents (you may hand off only
// what you could decide), so a delegate cannot re-delegate without the role.

/** Who may decide THIS pending approval. */
export function mayDecide(
  session: Pick<SessionClaims, "roles" | "principal">,
  delegatedTo: string | undefined,
): boolean {
  return can(session.roles, "approve_intents") || (delegatedTo !== undefined && session.principal === delegatedTo);
}

/** The run's current delegate, computed from the LOG alone (never a form). */
export async function delegatedToFromStore(
  store: EventStore | null,
  runId: string,
): Promise<string | undefined> {
  if (store === null) return undefined;
  const loaded = await store.load(runId);
  if (loaded === null) return undefined;
  const replayed = replay(loaded.events);
  if (!replayed.ok || replayed.state.status !== "awaiting_approval") return undefined;
  return replayed.state.pendingApproval?.delegatedTo;
}
