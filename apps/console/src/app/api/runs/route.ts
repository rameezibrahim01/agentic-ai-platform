import { readFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { baseName, readAgentsConfig } from "../../../lib/agents";
import { currentSession } from "../../../lib/auth";
import { errorRedirectPath, wantsHtml } from "../../../lib/http";
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

  const form = await request.formData();
  const agent = String(form.get("agent") ?? "");

  // a browser form post lands back on the run page with the message rendered;
  // programmatic callers keep JSON + the status code (issue #105)
  const refuse = (status: number, error: string): NextResponse =>
    wantsHtml(request.headers.get("accept")) && agent
      ? NextResponse.redirect(
          new URL(
            errorRedirectPath(`/agents/${encodeURIComponent(baseName(agent))}/run`, error),
            request.url,
          ),
          303,
        )
      : NextResponse.json({ error }, { status });

  const registry = await readAgentsConfig(process.env, (path) => readFile(path, "utf8"));
  if (!registry.ok) {
    return refuse(
      409,
      registry.kind === "not-configured"
        ? "no AGENTS_CONFIG mounted — there is nothing to run"
        : registry.error,
    );
  }

  const result = buildLaunch(
    registry.config,
    {
      agent,
      runId: String(form.get("runId") ?? ""),
      input: String(form.get("input") ?? ""),
      inputMode: form.get("inputMode") === "json" ? "json" : "text",
    },
    session,
    process.env["PLATFORM_ENV"] ?? "prod",
  );
  if (!result.ok) {
    return refuse(result.status, result.error);
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
