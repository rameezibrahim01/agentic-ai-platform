import { NextResponse, type NextRequest } from "next/server";
import { getControlPlane } from "../../../../lib/control-plane";
import { handleWebhookDelivery } from "../../../../lib/hooks";
import { startAgentRunByName } from "../../../../lib/temporal";

// Event-trigger endpoint (ticket 023). Authentication is the trigger's HMAC
// over the RAW body — no session: webhook senders are machines. All decision
// logic lives in handleWebhookDelivery (unit-tested); this adapter only
// extracts the raw request parts.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> },
): Promise<NextResponse> {
  const { triggerId } = await params;
  const rawBody = await request.text();
  const controlPlane = await getControlPlane();

  const result = await handleWebhookDelivery(
    {
      templates: controlPlane.templates,
      triggers: controlPlane.triggers,
      startRun: ({ workflowId, input }) => startAgentRunByName(workflowId, input),
    },
    {
      triggerId: decodeURIComponent(triggerId),
      deliveryId: request.headers.get("x-delivery"),
      signature: request.headers.get("x-signature"),
      rawBody,
    },
  );
  return NextResponse.json(result.body, { status: result.status });
}
