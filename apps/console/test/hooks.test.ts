import { describe, expect, it } from "vitest";
import {
  InMemoryTemplateStore,
  InMemoryTriggerStore,
  signWebhook,
  type RunTemplate,
  type WebhookTrigger,
} from "@platform/templates";
import { handleWebhookDelivery, type WebhookDeps } from "../src/lib/hooks";

const TEMPLATE: RunTemplate = {
  id: "tpl-triage",
  name: "Ticket triage",
  owner: "user:maya",
  agent: "triage@v1",
  params: {
    model: "stub-model",
    prompt: "triage the incoming ticket",
    input: { queue: "support" },
    approvalTtlMs: 600_000,
    standingGrantId: "grant-triage-1",
  },
  grants: [{ principal: "svc:zendesk-hook", access: "trigger" }],
  rev: 0,
};

const TRIGGER: WebhookTrigger = {
  id: "hook-zendesk",
  templateId: TEMPLATE.id,
  secret: "hook-secret-0123456789abcdef",
  enabled: true,
  createdBy: "svc:zendesk-hook",
};

const PAYLOAD = JSON.stringify({ ticket: 4821, kind: "escalation" });

async function makeDeps(overrides: { template?: RunTemplate; trigger?: WebhookTrigger } = {}) {
  const templates = new InMemoryTemplateStore();
  const triggers = new InMemoryTriggerStore();
  const template = overrides.template ?? TEMPLATE;
  await templates.create(template);
  await triggers.create(overrides.trigger ?? TRIGGER, template);
  const started: { workflowId: string; input: Record<string, unknown> }[] = [];
  const deps: WebhookDeps = {
    templates,
    triggers,
    startRun: async (request) => {
      const duplicate = started.some((s) => s.workflowId === request.workflowId);
      started.push(request);
      return duplicate ? "duplicate" : "started";
    },
  };
  return { deps, triggers, started };
}

const delivery = (over: Partial<Parameters<typeof handleWebhookDelivery>[1]> = {}) => ({
  triggerId: TRIGGER.id,
  deliveryId: "dlv-001",
  signature: signWebhook(TRIGGER.secret, PAYLOAD),
  rawBody: PAYLOAD,
  ...over,
});

describe("webhook delivery handling (ticket 023)", () => {
  it("a signed delivery starts the template's run with the payload as data under input.event", async () => {
    const { deps, started } = await makeDeps();
    const result = await handleWebhookDelivery(deps, delivery());
    expect(result).toEqual({
      status: 202,
      body: { ok: true, runId: "hook-hook-zendesk-dlv-001", deduped: false },
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      workflowId: "hook-hook-zendesk-dlv-001",
      input: {
        agent: "triage@v1",
        principal: "user:maya", // on whose behalf: the template owner
        input: { queue: "support", event: { ticket: 4821, kind: "escalation" } },
        model: "stub-model",
        prompt: "triage the incoming ticket",
        approvalTtlMs: 600_000,
        standingGrantId: "grant-triage-1", // threaded untouched (020 resolves it)
      },
    });
  });

  it("redelivery of the same delivery id maps to the same workflowId and reports deduped", async () => {
    const { deps, started } = await makeDeps();
    await handleWebhookDelivery(deps, delivery());
    const second = await handleWebhookDelivery(deps, delivery());
    expect(second).toEqual({
      status: 202,
      body: { ok: true, runId: "hook-hook-zendesk-dlv-001", deduped: true },
    });
    expect(new Set(started.map((s) => s.workflowId)).size).toBe(1);
  });

  it("tampered or missing signatures never start a run", async () => {
    const { deps, started } = await makeDeps();
    const tampered = await handleWebhookDelivery(
      deps,
      delivery({ rawBody: PAYLOAD.replace("4821", "9999") }),
    );
    expect(tampered.status).toBe(401);
    const missing = await handleWebhookDelivery(deps, delivery({ signature: null }));
    expect(missing).toEqual({ status: 401, body: { ok: false, error: "missing_signature" } });
    expect(started).toHaveLength(0);
  });

  it("unknown trigger 404s; a disabled trigger 409s without touching the engine", async () => {
    const { deps, triggers, started } = await makeDeps();
    expect((await handleWebhookDelivery(deps, delivery({ triggerId: "ghost" }))).status).toBe(404);
    await triggers.disable(TRIGGER.id);
    const disabled = await handleWebhookDelivery(deps, delivery());
    expect(disabled).toEqual({ status: 409, body: { ok: false, error: "trigger disabled" } });
    expect(started).toHaveLength(0);
  });

  it("a missing or malformed delivery id is a 400 (idempotency key is mandatory)", async () => {
    const { deps, started } = await makeDeps();
    expect((await handleWebhookDelivery(deps, delivery({ deliveryId: null }))).status).toBe(400);
    expect(
      (await handleWebhookDelivery(deps, delivery({ deliveryId: "no spaces allowed" }))).status,
    ).toBe(400);
    expect(started).toHaveLength(0);
  });

  it("trigger access is re-checked at fire time: a revoked grant bites", async () => {
    // same trigger, but the template no longer grants its creator `trigger`
    const revoked: RunTemplate = { ...TEMPLATE, grants: [] };
    const { started } = await makeDeps();
    const templates = new InMemoryTemplateStore();
    await templates.create(revoked);
    const triggers = new InMemoryTriggerStore();
    // register directly against the map by using a template that still grants
    const granting: RunTemplate = { ...TEMPLATE, id: TEMPLATE.id };
    expect((await triggers.create(TRIGGER, granting)).ok).toBe(true);
    const deps: WebhookDeps = {
      templates, // serves the revoked version at fire time
      triggers,
      startRun: async () => "started",
    };
    const result = await handleWebhookDelivery(deps, delivery());
    expect(result.status).toBe(403);
    expect(started).toHaveLength(0);
  });
});
