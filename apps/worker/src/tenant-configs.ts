import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// Per-lane config resolution (ticket 041) — the 037 limits pattern applied
// to tools and models: `<kind>.<tenantId>.config.json` beside the shared
// file governs that lane when present; absent falls back to the shared
// file; and building from an INVALID tenant file is a boot failure upstream,
// never a silent fallback to shared grants.

export type LaneConfigSource =
  | { source: "tenant"; path: string }
  | { source: "shared"; path: string }
  | { source: "none" };

export async function resolveLaneConfig(
  sharedPath: string | undefined,
  kind: "tools" | "models",
  tenantId: string,
): Promise<LaneConfigSource> {
  if (!sharedPath) return { source: "none" }; // no anchor directory → no overrides either
  const tenantPath = join(dirname(sharedPath), `${kind}.${tenantId}.config.json`);
  try {
    await stat(tenantPath);
    return { source: "tenant", path: tenantPath };
  } catch {
    return { source: "shared", path: sharedPath };
  }
}

export function describeLaneConfig(resolved: LaneConfigSource): string {
  switch (resolved.source) {
    case "tenant":
      return `tenant(${resolved.path})`;
    case "shared":
      return "shared";
    case "none":
      return "none";
  }
}
