import { z } from "zod";
import { agentVersionSpecSchema } from "@platform/evals";
import type { AgentVersionSpec } from "@platform/evals";

// Agent registry read surface (ticket 052). The version spec comes from the
// shared pure package (packages are fine in the Next bundle — the WORKER
// package is what must never enter it, so the pointer/alias shape is
// duplicated from apps/worker/src/agents/registry.ts like consoleLimitsSchema
// duplicates the limits shape). The file is read FRESH per request: a
// promote.sh edit must show up on reload, so nothing here caches.

const pointerSchema = z
  .object({
    current: z.string().min(1),
    /** Written by promote; what rollback restores. */
    previous: z.string().min(1).optional(),
  })
  .strict();

export const consoleAgentsSchema = z
  .object({
    versions: z.array(agentVersionSpecSchema).min(1),
    /** alias → env → pointer. Aliases must resolve to registered versions. */
    aliases: z.record(z.record(pointerSchema)),
  })
  .strict();

export type ConsoleAgentsConfig = z.infer<typeof consoleAgentsSchema>;
export type AgentPointer = z.infer<typeof pointerSchema>;

export type ReadAgentsResult =
  | { ok: true; config: ConsoleAgentsConfig; path: string }
  | { ok: false; kind: "not-configured" }
  | { ok: false; kind: "unreadable" | "invalid"; error: string };

/** Parse + the same referential checks as the worker's loadAgentsConfig —
 * a pointer at an unregistered version is an invalid file, not a UI blank. */
export function parseAgentsConfig(
  raw: unknown,
): { ok: true; config: ConsoleAgentsConfig } | { ok: false; error: string } {
  const parsed = consoleAgentsSchema.safeParse(raw);
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

export async function readAgentsConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string>,
): Promise<ReadAgentsResult> {
  const path = env["AGENTS_CONFIG"];
  if (path === undefined || path === "") return { ok: false, kind: "not-configured" };
  let raw: unknown;
  try {
    raw = JSON.parse(await read(path));
  } catch (error) {
    return {
      ok: false,
      kind: "unreadable",
      error: `cannot read agents config at ${path}: ${(error as Error).message}`,
    };
  }
  const parsed = parseAgentsConfig(raw);
  return parsed.ok
    ? { ok: true, config: parsed.config, path }
    : { ok: false, kind: "invalid", error: parsed.error };
}

const VERSION_SUFFIX = /@v([0-9]+)$/;

export function baseName(id: string): string {
  return id.replace(VERSION_SUFFIX, "");
}

export function versionNumber(id: string): number {
  const match = VERSION_SUFFIX.exec(id);
  return match ? Number(match[1]) : 0;
}

export interface CatalogRow {
  name: string;
  /** false = orphan versions: registered but reachable only as direct name@vN. */
  aliased: boolean;
  /** [env, pointer], env-sorted. Empty for orphans. */
  envs: [string, AgentPointer][];
  /** Newest first. */
  versions: AgentVersionSpec[];
}

/** Group every registered version by base name; alias-less names are still
 * rows (orphans) — the catalog must show everything that exists. */
export function agentCatalog(config: ConsoleAgentsConfig): CatalogRow[] {
  const byName = new Map<string, AgentVersionSpec[]>();
  for (const version of config.versions) {
    const name = baseName(version.id);
    const list = byName.get(name) ?? [];
    list.push(version);
    byName.set(name, list);
  }
  // aliases with no version rows cannot exist (referential checks), but a
  // name is listed even when only the alias map mentions it defensively
  for (const alias of Object.keys(config.aliases)) {
    if (!byName.has(alias)) byName.set(alias, []);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, versions]) => {
      const envs = config.aliases[name];
      return {
        name,
        aliased: envs !== undefined,
        envs: envs === undefined ? [] : Object.entries(envs).sort(([a], [b]) => a.localeCompare(b)),
        versions: [...versions].sort((a, b) => versionNumber(b.id) - versionNumber(a.id)),
      };
    });
}

export function catalogRowFor(config: ConsoleAgentsConfig, name: string): CatalogRow | undefined {
  return agentCatalog(config).find((row) => row.name === name);
}

/** Which env pointers reference this version, e.g. ["dev (current)", "prod (previous)"]. */
export function pointerRefs(row: CatalogRow, id: string): string[] {
  const refs: string[] = [];
  for (const [env, pointer] of row.envs) {
    if (pointer.current === id) refs.push(`${env} (current)`);
    if (pointer.previous === id) refs.push(`${env} (previous — what rollback restores)`);
  }
  return refs;
}
