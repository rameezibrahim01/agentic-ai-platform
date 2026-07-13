import { z } from "zod";
import { agentVersionSpecSchema } from "@platform/evals";
import { can } from "@platform/auth";
import type { SessionClaims } from "@platform/auth";
import type { OpsAuditStore } from "@platform/storage";
import { baseName, parseAgentsConfig, versionNumber } from "./agents";
import type { ConsoleAgentsConfig } from "./agents";

// Agent builder write path (ticket 053), on the 047 doctrine: validate the
// current file, refuse to touch a malformed one, round-trip-validate the
// proposed next content, and record the action — or its refusal — in
// ops_audit. The builder can only APPEND versions: a published version is
// immutable forever, so 028's digest discipline and one-command rollback
// keep their meaning with a second writer in play.

const riskSchema = z.enum(["read", "write", "irreversible", "financial"]);

export const agentDraftSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "name must be lowercase letters/digits/hyphens"),
    description: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().min(1),
    /** Documents intent; grants still come from the deployment tools config. */
    tools: z
      .array(
        z.object({ name: z.string().min(1), version: z.string().min(1), risk: riskSchema }).strict(),
      )
      .default([]),
    budget: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
        maxWallMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    approvalTtlMs: z.number().int().positive().optional(),
  })
  .strict();

export type AgentDraft = z.infer<typeof agentDraftSchema>;

export type DraftResult =
  | { ok: true; config: ConsoleAgentsConfig; id: string }
  | { ok: false; error: string };

/**
 * Append `name@vN+1` (next free N) to the registry. A brand-new name also
 * gets its alias with the DEV pointer only — prod pointers move exclusively
 * through promotion (028/055). Every prior version must survive byte-identical:
 * asserted structurally, not assumed.
 */
export function draftVersion(config: ConsoleAgentsConfig, rawDraft: unknown): DraftResult {
  const parsedDraft = agentDraftSchema.safeParse(rawDraft);
  if (!parsedDraft.success) {
    return {
      ok: false,
      error: `invalid draft: ${parsedDraft.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const draft = parsedDraft.data;
  const priorNs = config.versions
    .filter((v) => baseName(v.id) === draft.name)
    .map((v) => versionNumber(v.id));
  const id = `${draft.name}@v${priorNs.length === 0 ? 1 : Math.max(...priorNs) + 1}`;

  const spec = agentVersionSpecSchema.safeParse({
    id,
    description: draft.description,
    prompt: draft.prompt,
    model: draft.model,
    tools: draft.tools,
    ...(draft.budget !== undefined ? { budget: draft.budget } : {}),
    ...(draft.approvalTtlMs !== undefined ? { approvalTtlMs: draft.approvalTtlMs } : {}),
  });
  if (!spec.success) {
    return {
      ok: false,
      error: `draft does not form a valid version: ${spec.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  if (config.versions.some((v) => v.id === id)) {
    return { ok: false, error: `version ${id} already exists — versions are immutable` };
  }

  const next: ConsoleAgentsConfig = {
    versions: [...config.versions, spec.data],
    aliases:
      config.aliases[draft.name] !== undefined
        ? config.aliases
        : { ...config.aliases, [draft.name]: { dev: { current: id } } },
  };

  // append-only, asserted structurally: every published version byte-identical
  for (const [index, prior] of config.versions.entries()) {
    if (JSON.stringify(next.versions[index]) !== JSON.stringify(prior)) {
      return { ok: false, error: `refusing: draft would alter published version ${prior.id}` };
    }
  }
  const revalidated = parseAgentsConfig(JSON.parse(JSON.stringify(next)));
  if (!revalidated.ok) {
    return { ok: false, error: `refusing: next config fails validation: ${revalidated.error}` };
  }
  return { ok: true, config: revalidated.config, id };
}

export interface CreateDeps {
  session: Pick<SessionClaims, "roles" | "tenant" | "principal">;
  /** AGENTS_CONFIG; undefined = no registry mounted, creates impossible. */
  agentsPath: string | undefined;
  /** null = file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** May throw (read-only mount) — surfaced as a refusal, never a crash. */
  writeFile(path: string, content: string): Promise<void>;
  audit: OpsAuditStore;
  nowMs(): number;
}

export interface CreateResponse {
  status: 200 | 400 | 403 | 409;
  body: Record<string, unknown>;
}

/** The whole create path, pure over injected deps — the route is an adapter. */
export async function handleAgentCreate(deps: CreateDeps, rawDraft: unknown): Promise<CreateResponse> {
  const scope = deps.session.tenant !== undefined ? `tenant:${deps.session.tenant}` : "shared";
  if (!can(deps.session.roles, "author_agents")) {
    // refusals are audited too — the gateway's refuse-and-audit doctrine,
    // applied to authors
    await deps.audit.record({
      at: deps.nowMs(),
      principal: deps.session.principal,
      action: "agent_version_create_refused",
      scope,
      detail: { reason: "forbidden" },
    });
    return { status: 403, body: { error: "creating agent versions requires author_agents" } };
  }
  if (deps.agentsPath === undefined) {
    return { status: 409, body: { error: "no AGENTS_CONFIG mounted — there is no registry to write" } };
  }
  const raw = await deps.readFile(deps.agentsPath);
  if (raw === null) {
    return { status: 409, body: { error: "the agents registry file is missing" } };
  }
  let current: unknown;
  try {
    current = JSON.parse(raw);
  } catch {
    return { status: 409, body: { error: "the agents file is not valid JSON — fix it first, the builder never overwrites what it cannot read" } };
  }
  const parsed = parseAgentsConfig(current);
  if (!parsed.ok) {
    return { status: 409, body: { error: `the agents file is malformed — refusing to write: ${parsed.error}` } };
  }

  const drafted = draftVersion(parsed.config, rawDraft);
  if (!drafted.ok) {
    await deps.audit.record({
      at: deps.nowMs(),
      principal: deps.session.principal,
      action: "agent_version_create_refused",
      scope,
      detail: { reason: drafted.error },
    });
    return { status: 400, body: { error: drafted.error } };
  }

  try {
    await deps.writeFile(deps.agentsPath, `${JSON.stringify(drafted.config, null, 2)}\n`);
  } catch (error) {
    return {
      status: 409,
      body: {
        error: `the agents file is not writable in this deployment profile (${(error as Error).message}) — compose mounts it rw; on k8s move it off the configmap first`,
      },
    };
  }
  await deps.audit.record({
    at: deps.nowMs(),
    principal: deps.session.principal,
    action: "agent_version_created",
    scope,
    detail: {
      id: drafted.id,
      model: (rawDraft as { model?: string }).model ?? "",
      tools: ((rawDraft as { tools?: unknown[] }).tools ?? []).length,
      file: deps.agentsPath,
    },
  });
  return { status: 200, body: { ok: true, id: drafted.id, name: baseName(drafted.id) } };
}
