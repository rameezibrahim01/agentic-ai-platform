import { z } from "zod";
import { can } from "@platform/auth";
import type { SessionClaims } from "@platform/auth";
import type { ConsoleAgentsConfig } from "./agents";
import { taskQueueFor, workflowIdFor } from "./tenancy";

// Run launcher (ticket 054). The console is a run STARTER, not a second
// engine: it resolves alias → immutable spec exactly like demo-run.ts, builds
// the workflow input from the SPEC (the form can never override budgets,
// model, or prompt), stamps the signed-in user as principal, and derives the
// queue/workflowId from the session's tenant. Idempotency is a page-minted
// runId: resubmitting the same form is a duplicate start, which Temporal
// collapses onto the same run.

const VERSIONED = /@v[0-9]+$/;

export const launchRequestSchema = z
  .object({
    /** Alias (resolved via the env pointer) or a direct name@vN. */
    agent: z.string().min(1),
    /** Minted by the page render; resubmit = same run (003 idempotency). */
    runId: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/, "runId must be the page-minted token"),
    /** Free text, carried as { text }; "json" mode parses an object. */
    input: z.string().default(""),
    inputMode: z.enum(["text", "json"]).default("text"),
  })
  .strict();

export type LaunchRequest = z.infer<typeof launchRequestSchema>;

export type LaunchPlan = {
  workflowId: string;
  taskQueue: string;
  /** agentRun's input arg — shaped like the worker's AgentRunInput. */
  input: Record<string, unknown>;
  agentId: string;
  runId: string;
};

export type BuildLaunchResult =
  | { ok: true; plan: LaunchPlan }
  | { ok: false; status: 400 | 403 | 404; error: string };

export function buildLaunch(
  config: ConsoleAgentsConfig,
  rawRequest: unknown,
  session: Pick<SessionClaims, "roles" | "tenant" | "principal">,
  env: string,
): BuildLaunchResult {
  if (!can(session.roles, "start_runs")) {
    return { ok: false, status: 403, error: "starting runs requires start_runs (agent_developer)" };
  }
  const parsed = launchRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: `invalid launch: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const request = parsed.data;

  // same resolution rule as the worker's resolveAgentAlias: a direct name@vN
  // is itself; a bare alias goes through this environment's pointer
  const id = VERSIONED.test(request.agent)
    ? request.agent
    : config.aliases[request.agent]?.[env]?.current;
  if (id === undefined) {
    return { ok: false, status: 404, error: `no ${env} pointer for alias ${request.agent}` };
  }
  const spec = config.versions.find((v) => v.id === id);
  if (spec === undefined) {
    return { ok: false, status: 404, error: `agent version ${id} is not registered` };
  }

  let input: unknown;
  if (request.inputMode === "json") {
    try {
      input = JSON.parse(request.input);
    } catch {
      return { ok: false, status: 400, error: "input is not valid JSON" };
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, status: 400, error: "JSON input must be an object" };
    }
  } else {
    input = { text: request.input };
  }

  return {
    ok: true,
    plan: {
      workflowId: workflowIdFor(request.runId, session.tenant),
      taskQueue: taskQueueFor(session.tenant),
      agentId: id,
      runId: request.runId,
      input: {
        runId: request.runId,
        agent: id,
        principal: session.principal.startsWith("user:")
          ? session.principal
          : `user:${session.principal}`,
        input,
        // the SPEC wins — the form carries no model/prompt/budget fields,
        // and anything smuggled into the POST dies in the strict schema
        model: spec.model,
        prompt: spec.prompt,
        ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
        ...(spec.loopDetection !== undefined ? { loopDetection: spec.loopDetection } : {}),
        ...(spec.approvalTtlMs !== undefined ? { approvalTtlMs: spec.approvalTtlMs } : {}),
      },
    },
  };
}

/** The runId minted at page render: URL-safe, collision-resistant enough for
 * a human-triggered start, and stable across a form resubmit. */
export function mintRunId(randomHex: string): string {
  return `web-${randomHex.toLowerCase()}`;
}
