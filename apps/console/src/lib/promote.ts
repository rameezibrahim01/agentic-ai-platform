import { can } from "@platform/auth";
import type { SessionClaims } from "@platform/auth";
import type { OpsAuditStore } from "@platform/storage";
import { parseAgentsConfig } from "./agents";
import type { AgentPointer, ConsoleAgentsConfig } from "./agents";
import manifest from "./eval-manifest.json";

// Promote & rollback from the console (ticket 055). Versions are immutable;
// only POINTERS move — the same surgery as scripts/promote.sh|rollback.sh
// (apps/worker/src/evals/promote.ts), done immutably. One honesty rule the
// CLI gate cannot give us: the console cannot run the eval suite, so a
// version with no in-repo suite promotes marked "unproven" — said in the
// confirm copy and stamped into the audit record, never hidden. Rollback is
// NEVER gated, by eval status or anything else: a rollback that waits is
// not a rollback.

export type EvalStatus = "suite-green-in-ci" | "unproven";

/** In-repo suites (kept in eval-manifest.json; a test fails on drift from
 * the worker's SUITES registry). Green in CI is implied: a red suite cannot
 * merge, so a manifest entry on main IS the gate's receipt. */
export function evalStatusFor(id: string): EvalStatus {
  return (manifest.agentsWithSuites as string[]).includes(id) ? "suite-green-in-ci" : "unproven";
}

export type PointerMove =
  | { ok: true; config: ConsoleAgentsConfig; from: string | undefined; to: string }
  | { ok: false; error: string };

/** Same refusals as the CLI plus: the console only moves pointers of
 * EXISTING aliases (the builder mints them; a typo'd alias is a bug, not a
 * new alias). */
export function movePointer(
  config: ConsoleAgentsConfig,
  request: { name: string; env: string; to: string },
): PointerMove {
  const envs = config.aliases[request.name];
  if (envs === undefined) {
    return { ok: false, error: `no alias ${request.name} — the builder creates aliases, promote only moves them` };
  }
  if (!config.versions.some((v) => v.id === request.to)) {
    return { ok: false, error: `version ${request.to} is not registered — mint it first` };
  }
  const from = envs[request.env]?.current;
  if (from === request.to) {
    return { ok: false, error: `${request.name}/${request.env} already points at ${request.to}` };
  }
  const pointer: AgentPointer = {
    current: request.to,
    ...(from !== undefined ? { previous: from } : {}),
  };
  return {
    ok: true,
    from,
    to: request.to,
    config: {
      ...config,
      aliases: { ...config.aliases, [request.name]: { ...envs, [request.env]: pointer } },
    },
  };
}

export function rollbackPointer(
  config: ConsoleAgentsConfig,
  request: { name: string; env: string },
): PointerMove {
  const pointer = config.aliases[request.name]?.[request.env];
  if (pointer === undefined) {
    return { ok: false, error: `no ${request.env} pointer for alias ${request.name}` };
  }
  if (pointer.previous === undefined) {
    return { ok: false, error: `${request.name}/${request.env} has no previous version recorded` };
  }
  return {
    ok: true,
    from: pointer.current,
    to: pointer.previous,
    config: {
      ...config,
      aliases: {
        ...config.aliases,
        [request.name]: {
          ...config.aliases[request.name],
          [request.env]: { current: pointer.previous, previous: pointer.current },
        },
      },
    },
  };
}

export interface PointerDeps {
  session: Pick<SessionClaims, "roles" | "tenant" | "principal">;
  agentsPath: string | undefined;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  audit: OpsAuditStore;
  nowMs(): number;
}

export type PointerRequest =
  | { kind: "promote"; name: string; env: string; to: string }
  | { kind: "rollback"; name: string; env: string };

export interface PointerResponse {
  status: 200 | 400 | 403 | 409;
  body: Record<string, unknown>;
}

/** dev pointers belong to authors; every other environment is an operator
 * lever. Rollback obeys the same ROLE gates — but never an eval gate. */
export function pointerGate(
  session: Pick<SessionClaims, "roles">,
  env: string,
): "admitted" | "forbidden" {
  const action = env === "dev" ? ("author_agents" as const) : ("manage_platform" as const);
  return can(session.roles, action) ? "admitted" : "forbidden";
}

export async function handlePointerMove(
  deps: PointerDeps,
  request: PointerRequest,
): Promise<PointerResponse> {
  const scope = deps.session.tenant !== undefined ? `tenant:${deps.session.tenant}` : "shared";
  const refuse = async (
    status: 400 | 403 | 409,
    reason: string,
  ): Promise<PointerResponse> => {
    await deps.audit.record({
      at: deps.nowMs(),
      principal: deps.session.principal,
      action: "agent_pointer_move_refused",
      scope,
      detail: { reason, request: { ...request } },
    });
    return { status, body: { error: reason } };
  };

  if (pointerGate(deps.session, request.env) === "forbidden") {
    return refuse(
      403,
      request.env === "dev"
        ? "moving dev pointers requires author_agents"
        : `moving ${request.env} pointers requires manage_platform`,
    );
  }
  if (deps.agentsPath === undefined) {
    return { status: 409, body: { error: "no AGENTS_CONFIG mounted — there are no pointers to move" } };
  }
  const raw = await deps.readFile(deps.agentsPath);
  if (raw === null) {
    return { status: 409, body: { error: "the agents registry file is missing" } };
  }
  let parsed: ReturnType<typeof parseAgentsConfig>;
  try {
    parsed = parseAgentsConfig(JSON.parse(raw));
  } catch {
    return { status: 409, body: { error: "the agents file is not valid JSON — the lever never 'fixes' config" } };
  }
  if (!parsed.ok) {
    return { status: 409, body: { error: `the agents file is malformed — refusing to move pointers: ${parsed.error}` } };
  }

  const moved =
    request.kind === "promote"
      ? movePointer(parsed.config, request)
      : rollbackPointer(parsed.config, request);
  if (!moved.ok) return refuse(400, moved.error);

  const evalStatus = evalStatusFor(moved.to);
  try {
    await deps.writeFile(deps.agentsPath, `${JSON.stringify(moved.config, null, 2)}\n`);
  } catch (error) {
    return {
      status: 409,
      body: { error: `the agents file is not writable in this deployment profile (${(error as Error).message})` },
    };
  }
  await deps.audit.record({
    at: deps.nowMs(),
    principal: deps.session.principal,
    action: request.kind === "promote" ? "agent_pointer_promoted" : "agent_pointer_rolled_back",
    scope,
    detail: {
      alias: request.name,
      env: request.env,
      from: moved.from ?? null,
      to: moved.to,
      // the honesty marker: a version with no in-repo suite is UNPROVEN
      evalStatus,
      file: deps.agentsPath,
    },
  });
  return {
    status: 200,
    body: { ok: true, alias: request.name, env: request.env, from: moved.from ?? null, to: moved.to, evalStatus },
  };
}
