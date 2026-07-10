import { z } from "zod";
import { agentVersionSpecSchema } from "@platform/evals";
import type { AgentVersionSpec } from "@platform/evals";

// The agent registry + environment pointers (ticket 028). Versions are
// immutable — 028's digest suite makes mutating a published one a CI
// failure — so promotion is just moving a pointer, and rollback is moving
// it back: one command, no rebuild, because the old version never stopped
// existing.

const pointerSchema = z
  .object({
    current: z.string().min(1),
    /** Written by promote; what rollback restores. */
    previous: z.string().min(1).optional(),
  })
  .strict();

export const agentsConfigSchema = z
  .object({
    versions: z.array(agentVersionSpecSchema).min(1),
    /** alias → env → pointer. Aliases must resolve to registered versions. */
    aliases: z.record(z.record(pointerSchema)),
  })
  .strict();

export type AgentsConfig = z.infer<typeof agentsConfigSchema>;

export type LoadAgentsResult =
  | { ok: true; config: AgentsConfig }
  | { ok: false; error: string };

export function loadAgentsConfig(raw: unknown): LoadAgentsResult {
  const parsed = agentsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid agents config: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const known = new Set(parsed.data.versions.map((v) => v.id));
  for (const [alias, envs] of Object.entries(parsed.data.aliases)) {
    for (const [env, pointer] of Object.entries(envs)) {
      if (!known.has(pointer.current)) {
        return { ok: false, error: `alias ${alias}/${env} points at unknown ${pointer.current}` };
      }
      if (pointer.previous !== undefined && !known.has(pointer.previous)) {
        return {
          ok: false,
          error: `alias ${alias}/${env} remembers unknown previous ${pointer.previous}`,
        };
      }
    }
  }
  return { ok: true, config: parsed.data };
}

export type ResolveResult =
  | { ok: true; id: string; spec: AgentVersionSpec }
  | { ok: false; error: string };

const VERSIONED = /@v[0-9]+$/;

/**
 * "name@vN" resolves to itself (direct references keep working unchanged);
 * a bare alias resolves through the environment pointer.
 */
export function resolveAgentAlias(
  config: AgentsConfig,
  aliasOrId: string,
  env: string,
): ResolveResult {
  const id = VERSIONED.test(aliasOrId) ? aliasOrId : config.aliases[aliasOrId]?.[env]?.current;
  if (id === undefined) {
    return { ok: false, error: `no ${env} pointer for alias ${aliasOrId}` };
  }
  const spec = config.versions.find((v) => v.id === id);
  return spec === undefined
    ? { ok: false, error: `agent version ${id} is not registered` }
    : { ok: true, id, spec };
}
