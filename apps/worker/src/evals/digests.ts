import { createHash } from "node:crypto";
import type { AgentVersionSpec } from "@platform/evals";

// Published-version immutability, enforced (ticket 028): every agent version
// on main has its content digest committed. Changing what "name@vN" means
// without minting vN+1 breaks the digest suite — versions append, never
// mutate (the same discipline as the run event log, applied to config).

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentVersionDigest(spec: AgentVersionSpec): string {
  return `sha256:${createHash("sha256").update(canonical(spec), "utf8").digest("hex")}`;
}

export interface DigestMismatch {
  id: string;
  problem: "changed" | "unrecorded";
  expected?: string;
  actual: string;
}

/** Compare live specs against the committed digest file. */
export function verifyAgentDigests(
  versions: readonly AgentVersionSpec[],
  recorded: Readonly<Record<string, string>>,
): DigestMismatch[] {
  const mismatches: DigestMismatch[] = [];
  for (const spec of versions) {
    const actual = agentVersionDigest(spec);
    const expected = recorded[spec.id];
    if (expected === undefined) {
      mismatches.push({ id: spec.id, problem: "unrecorded", actual });
    } else if (expected !== actual) {
      mismatches.push({ id: spec.id, problem: "changed", expected, actual });
    }
  }
  return mismatches;
}
