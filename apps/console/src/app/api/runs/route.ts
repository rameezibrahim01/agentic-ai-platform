import { readFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "../../../lib/auth";
import { readAgentsConfig } from "../../../lib/agents";
import { buildLaunch } from "../../../lib/launch";
import { startAgentRunByName } from "../../../lib/temporal";

// Start a run from the browser (ticket 054). All decisions live in
// lib/launch.ts (buildLaunch, pure); this adapter binds the session, the
// registry file, and the Temporal client. "duplicate" ALSO redirects to the
// run — idempotency as UX, not an error.

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) {
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }

  const registry = await readAgentsConfig(process.env, (path) => readFile(path, "utf8"));
  if (!registry.ok) {
    return NextResponse.json(
      {
        error:
          registry.kind === "not-configured"
            ? "no AGENTS_CONFIG mounted — there is nothing to run"
            : registry.error,
      },
      { status: 409 },
    );
  }

  const form = await request.formData();
  const result = buildLaunch(
    registry.config,
    {
      agent: String(form.get("agent") ?? ""),
      runId: String(form.get("runId") ?? ""),
      input: String(form.get("input") ?? ""),
      inputMode: form.get("inputMode") === "json" ? "json" : "text",
    },
    session,
    process.env["PLATFORM_ENV"] ?? "prod",
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await startAgentRunByName(result.plan.workflowId, result.plan.input, {
    taskQueue: result.plan.taskQueue,
  });
  // started OR duplicate: the run page is the answer either way
  return NextResponse.redirect(
    new URL(`/runs/${encodeURIComponent(result.plan.runId)}`, request.url),
    303,
  );
}
