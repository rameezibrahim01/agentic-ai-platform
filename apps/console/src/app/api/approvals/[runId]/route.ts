import { NextResponse, type NextRequest } from "next/server";
import { can } from "@platform/auth";
import { currentSession } from "../../../../lib/auth";
import { getStore, isTenanted } from "../../../../lib/store";
import { decideApprovalSignal } from "../../../../lib/tenancy";
import { signalApprovalDecision } from "../../../../lib/temporal";

// Approve/deny a pending intent. The decision is signed by the SESSION
// principal — the audit's `who` is the human who clicked, never a service
// account (ticket 018). In a tenanted deployment (038) the SESSION tenant's
// store gates the signal: a run the session cannot see is a 404, and no
// signal leaves the console.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) {
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }
  if (!can(session.roles, "approve_intents")) {
    return NextResponse.json(
      { error: "forbidden: approve_intents requires the approver or platform_admin role" },
      { status: 403 },
    );
  }

  const { runId } = await params;
  const form = await request.formData();
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json({ error: "decision must be approve or deny" }, { status: 400 });
  }
  const comment = String(form.get("comment") ?? "").trim();

  try {
    const outcome = await decideApprovalSignal(
      {
        tenanted: isTenanted(),
        store: await getStore(session.tenant),
        signal: (workflowId, d) => signalApprovalDecision(workflowId, d),
      },
      {
        runId: decodeURIComponent(runId),
        tenant: session.tenant,
        decision: {
          granted: decision === "approve",
          by: session.principal,
          ...(comment ? { comment } : {}),
        },
      },
    );
    if (outcome === "not_found") {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: "failed to signal the run engine",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
  return NextResponse.redirect(new URL("/approvals", request.url), 303);
}
