import { NextResponse, type NextRequest } from "next/server";
import { can } from "@platform/auth";
import { currentSession } from "../../../../lib/auth";
import { handleBatchDecision } from "../../../../lib/changesets";
import { getStore } from "../../../../lib/store";
import { workflowIdFor } from "../../../../lib/tenancy";
import { signalApprovalDecision } from "../../../../lib/temporal";
import { pendingApprovalsView } from "../../../../lib/viewmodels";

// Changeset decision (ticket 025): one human decision fanned out as one
// signal PER RUN — the audit trail stays per-run. The tier ceiling is
// enforced in handleBatchDecision against risks recomputed from the log,
// never trusted from the form.
export async function POST(request: NextRequest): Promise<NextResponse> {
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

  const form = await request.formData();
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json({ error: "decision must be approve or deny" }, { status: 400 });
  }
  const runIds = String(form.get("runIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const comment = String(form.get("comment") ?? "").trim();

  // the SESSION tenant's store feeds loadPending, so runIds outside the
  // tenant are refused as "not pending approval" — nothing is signalled
  const store = await getStore(session.tenant);
  if (store === null) {
    return NextResponse.json(
      { error: "this session is not bound to a tenant — nothing to decide" },
      { status: 404 },
    );
  }
  const result = await handleBatchDecision(
    {
      loadPending: () => pendingApprovalsView(store),
      signal: (runId, d) => signalApprovalDecision(workflowIdFor(runId, session.tenant), d),
    },
    {
      runIds,
      decision,
      by: session.principal,
      ...(comment ? { comment } : {}),
    },
  );
  if (result.status === 200) {
    return NextResponse.redirect(new URL("/approvals", request.url), 303);
  }
  return NextResponse.json(result.body, { status: result.status });
}
