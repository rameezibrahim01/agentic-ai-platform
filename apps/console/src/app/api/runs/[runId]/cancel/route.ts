import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { replay } from "@platform/core";
import { currentSession } from "../../../../../lib/auth";
import { errorRedirectPath, wantsHtml } from "../../../../../lib/http";
import { getOpsAudit } from "../../../../../lib/ops-audit";
import { handleSwitchFlip } from "../../../../../lib/switches";
import { getStore, isTenanted } from "../../../../../lib/store";

// Cancel THIS run (ticket 064): a kill switch with a one-run blast radius,
// through the exact same audited write path as every other flip (047). The
// engine enforces it at the run's next step; this route only moves the lever.

async function writeFileNearAtomic(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.limits-flip-${process.pid}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch {
    await writeFile(path, content, "utf8");
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) {
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }
  const { runId: rawRunId } = await params;
  const runId = decodeURIComponent(rawRunId);
  const browser = wantsHtml(request.headers.get("accept"));
  const runPath = `/runs/${encodeURIComponent(runId)}`;
  const fail = (status: 400 | 403 | 409, error: string): NextResponse =>
    browser
      ? NextResponse.redirect(new URL(errorRedirectPath(runPath, error), request.url), 303)
      : NextResponse.json({ error }, { status });

  const audit = getOpsAudit();
  if (audit === null) {
    return fail(409, "cancel requires the audit store — set DATABASE_URL");
  }
  const store = await getStore(session.tenant);
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
      // housekeeping: finished runs' entries are pruned on the way through
      ...(store !== null
        ? {
            runIsTerminal: async (id: string) => {
              const loaded = await store.load(id);
              if (loaded === null) return false;
              const replayed = replay(loaded.events);
              if (!replayed.ok) return false;
              return (
                replayed.state.status === "completed" || replayed.state.status === "failed"
              );
            },
          }
        : {}),
    },
    { scope: "run", runId, tripped: true },
  );

  if (result.status === 200) {
    return NextResponse.redirect(new URL(runPath, request.url), 303);
  }
  const message = typeof result.body["error"] === "string" ? result.body["error"] : "cancel failed";
  return browser
    ? NextResponse.redirect(new URL(errorRedirectPath(runPath, message), request.url), 303)
    : NextResponse.json(result.body, { status: result.status });
}
