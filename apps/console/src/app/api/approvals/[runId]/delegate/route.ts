import { NextResponse, type NextRequest } from "next/server";
import { can } from "@platform/auth";
import { currentSession } from "../../../../../lib/auth";
import { getStore, isTenanted } from "../../../../../lib/store";
import { gateTenantRunSignal } from "../../../../../lib/tenancy";
import { signalApprovalDelegation } from "../../../../../lib/temporal";

// Hand a pending approval to a named person (ticket 050). Requires
// approve_intents — you may hand off only what you could decide. The fact
// lands in the run's log via the workflow (single-writer rule); the store
// lookup gates the signal exactly like decisions (038).
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
      { error: "forbidden: delegating requires the approver or platform_admin role" },
      { status: 403 },
    );
  }

  const { runId } = await params;
  const form = await request.formData();
  const toPrincipal = String(form.get("toPrincipal") ?? "").trim();
  if (!toPrincipal) {
    return NextResponse.json({ error: "toPrincipal is required" }, { status: 400 });
  }

  try {
    const outcome = await gateTenantRunSignal(
      {
        tenanted: isTenanted(),
        store: await getStore(session.tenant),
        signal: (workflowId) =>
          signalApprovalDelegation(workflowId, { toPrincipal, by: session.principal }),
      },
      { runId: decodeURIComponent(runId), tenant: session.tenant },
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
