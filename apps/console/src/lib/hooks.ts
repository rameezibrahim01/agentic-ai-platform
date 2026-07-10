import { canOnTemplate, verifyWebhook } from "@platform/templates";
import type { TemplateStore, TriggerStore } from "@platform/templates";

// Webhook delivery handling (ticket 023), pure over injected deps so the
// whole auth surface is unit-testable. A delivery becomes an ordinary
// `agentRun` whose input carries the payload under `input.event` — data,
// never instructions (CLAUDE.md #6). Idempotency: workflowId =
// `hook-<triggerId>-<deliveryId>`, so redeliveries dedupe at the engine
// (CLAUDE.md #3).

export interface WebhookDeps {
  templates: TemplateStore;
  triggers: TriggerStore;
  /** Start agentRun; must report a duplicate workflowId as "duplicate". */
  startRun(request: {
    workflowId: string;
    input: Record<string, unknown>;
  }): Promise<"started" | "duplicate">;
}

export interface DeliveryRequest {
  triggerId: string;
  deliveryId: string | null;
  signature: string | null;
  rawBody: string;
}

export type DeliveryResult =
  | { status: 202; body: { ok: true; runId: string; deduped: boolean } }
  | { status: 400 | 401 | 403 | 404 | 409; body: { ok: false; error: string } };

const DELIVERY_ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function handleWebhookDelivery(
  deps: WebhookDeps,
  request: DeliveryRequest,
): Promise<DeliveryResult> {
  const trigger = await deps.triggers.get(request.triggerId);
  if (trigger === undefined) {
    return { status: 404, body: { ok: false, error: "unknown trigger" } };
  }

  const verified = verifyWebhook(trigger, request.rawBody, request.signature);
  if (!verified.ok) {
    // disabled wins over signature problems: a dead trigger is dead
    if (verified.reason === "disabled") {
      return { status: 409, body: { ok: false, error: "trigger disabled" } };
    }
    return { status: 401, body: { ok: false, error: verified.reason } };
  }

  if (request.deliveryId === null || !DELIVERY_ID.test(request.deliveryId)) {
    return {
      status: 400,
      body: { ok: false, error: "x-delivery header required ([A-Za-z0-9._-], max 128)" },
    };
  }

  const template = await deps.templates.get(trigger.templateId);
  if (template === undefined) {
    return { status: 404, body: { ok: false, error: "template missing" } };
  }
  // re-checked at fire time: a grant removed after registration must bite
  if (!canOnTemplate(template, trigger.createdBy, "trigger")) {
    return {
      status: 403,
      body: { ok: false, error: "trigger creator no longer holds trigger access" },
    };
  }

  let event: unknown;
  try {
    event = JSON.parse(request.rawBody);
  } catch {
    event = request.rawBody; // non-JSON payloads carried verbatim, still data
  }

  const runId = `hook-${trigger.id}-${request.deliveryId}`;
  const { params } = template;
  const outcome = await deps.startRun({
    workflowId: runId,
    input: {
      agent: template.agent,
      principal: template.owner,
      input: { ...params.input, event },
      model: params.model,
      prompt: params.prompt,
      ...(params.budget !== undefined ? { budget: params.budget } : {}),
      ...(params.approvalTtlMs !== undefined ? { approvalTtlMs: params.approvalTtlMs } : {}),
      ...(params.standingGrantId !== undefined
        ? { standingGrantId: params.standingGrantId }
        : {}),
    },
  });
  return { status: 202, body: { ok: true, runId, deduped: outcome === "duplicate" } };
}
