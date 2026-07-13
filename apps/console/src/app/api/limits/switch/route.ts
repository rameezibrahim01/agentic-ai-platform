import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "../../../../lib/auth";
import { getOpsAudit } from "../../../../lib/ops-audit";
import { handleSwitchFlip } from "../../../../lib/switches";
import type { FlipRequest } from "../../../../lib/switches";
import { isTenanted } from "../../../../lib/store";

// The ONE console write action (ticket 047): flip a kill switch. Every
// decision lives in lib/switches.ts (handleSwitchFlip, pure over injected
// deps); this adapter binds the session, the filesystem, and the audit store.

async function writeFileNearAtomic(path: string, content: string): Promise<void> {
  // atomic where the fs allows it; single-file bind mounts (compose) refuse
  // rename-over-mountpoint, so fall back to an in-place truncate+write —
  // the worker's loader treats a torn read as a retryable parse failure
  const tmp = join(dirname(path), `.limits-flip-${process.pid}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch {
    await writeFile(path, content, "utf8");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) {
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }
  const audit = getOpsAudit();
  if (audit === null) {
    return NextResponse.json(
      { error: "flips require the audit store — set DATABASE_URL" },
      { status: 409 },
    );
  }

  const form = await request.formData();
  const scope = String(form.get("scope") ?? "");
  const tripped = String(form.get("tripped") ?? "");
  if ((scope !== "global" && scope !== "agent") || (tripped !== "true" && tripped !== "false")) {
    return NextResponse.json(
      { error: "scope must be global|agent and tripped must be true|false" },
      { status: 400 },
    );
  }
  const agent = String(form.get("agent") ?? "").trim();
  const tenant = String(form.get("tenant") ?? "").trim();
  const flip: FlipRequest & { tenant?: string } = {
    ...(scope === "global"
      ? { scope: "global" as const }
      : { scope: "agent" as const, agent }),
    tripped: tripped === "true",
    ...(tenant ? { tenant } : {}),
  };

  const sharedPath = process.env["LIMITS_CONFIG"];
  const result = await handleSwitchFlip(
    {
      session,
      tenanted: isTenanted(),
      sharedPath,
      pathFor: (target) =>
        target === "shared"
          ? sharedPath!
          : join(dirname(sharedPath!), `limits.${target.tenant}.config.json`),
      readFile: async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch {
          return null;
        }
      },
      writeFile: writeFileNearAtomic,
      audit,
      nowMs: () => Date.now(),
    },
    flip,
  );
  if (result.status === 200) {
    return NextResponse.redirect(new URL("/limits", request.url), 303);
  }
  return NextResponse.json(result.body, { status: result.status });
}
