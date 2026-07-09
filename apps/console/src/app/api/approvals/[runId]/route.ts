import { NextResponse, type NextRequest } from "next/server";
import { can } from "@platform/auth";
import { currentSession } from "../../../../lib/auth";
import { signalApprovalDecision } from "../../../../lib/temporal";

// Approve/deny a pending intent. The decision is signed by the SESSION
// principal — the audit's `who` is the human who clicked, never a service
// account (ticket 018).
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
    await signalApprovalDecision(decodeURIComponent(runId), {
      granted: decision === "approve",
      by: session.principal,
      ...(comment ? { comment } : {}),
    });
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
