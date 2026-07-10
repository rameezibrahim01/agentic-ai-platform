import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadAgentsConfig } from "../agents/registry.js";
import type { AgentsConfig } from "../agents/registry.js";

// Pointer surgery (ticket 028). Promotion is GATED by scripts/promote.sh
// (the target suite must pass first); rollback is deliberately ungated —
// a rollback that waits on an eval run is not a rollback.

const DEFAULT_CONFIG = fileURLToPath(
  new URL("../../../../deploy/agents.config.json", import.meta.url),
);

export type PointerChange =
  | { ok: true; alias: string; env: string; from: string | undefined; to: string }
  | { ok: false; error: string };

export function promotePointer(
  config: AgentsConfig,
  alias: string,
  version: string,
  env: string,
): PointerChange {
  if (!config.versions.some((v) => v.id === version)) {
    return { ok: false, error: `version ${version} is not registered — mint it first` };
  }
  const envs = (config.aliases[alias] ??= {});
  const pointer = envs[env];
  const from = pointer?.current;
  if (from === version) return { ok: false, error: `${alias}/${env} already points at ${version}` };
  envs[env] = { current: version, ...(from !== undefined ? { previous: from } : {}) };
  return { ok: true, alias, env, from, to: version };
}

export function rollbackPointer(config: AgentsConfig, alias: string, env: string): PointerChange {
  const pointer = config.aliases[alias]?.[env];
  if (pointer === undefined) return { ok: false, error: `no ${env} pointer for alias ${alias}` };
  if (pointer.previous === undefined) {
    return { ok: false, error: `${alias}/${env} has no previous version recorded` };
  }
  const from = pointer.current;
  config.aliases[alias]![env] = { current: pointer.previous, previous: from };
  return { ok: true, alias, env, from, to: pointer.previous };
}

async function main(): Promise<void> {
  const [, , command, alias, ...rest] = process.argv;
  const configPath = process.env["AGENTS_CONFIG"] ?? DEFAULT_CONFIG;
  const loaded = loadAgentsConfig(JSON.parse(await readFile(configPath, "utf8")));
  if (!loaded.ok) throw new Error(loaded.error);

  let change: PointerChange;
  if (command === "promote" && alias && rest.length === 2) {
    change = promotePointer(loaded.config, alias, rest[0]!, rest[1]!);
  } else if (command === "rollback" && alias && rest.length === 1) {
    change = rollbackPointer(loaded.config, alias, rest[0]!);
  } else {
    throw new Error("usage: promote <alias> <version> <env> | rollback <alias> <env>");
  }
  if (!change.ok) throw new Error(change.error);

  await writeFile(configPath, `${JSON.stringify(loaded.config, null, 2)}\n`, "utf8");
  console.log(
    `${command}: ${change.alias}/${change.env} ${change.from ?? "(unset)"} -> ${change.to}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
