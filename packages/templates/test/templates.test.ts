import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canOnTemplate,
  InMemoryTemplateStore,
  InMemoryTriggerStore,
  signWebhook,
  verifyWebhook,
  type RunTemplate,
  type TemplateAccess,
  type WebhookTrigger,
} from "@platform/templates";

const TEMPLATE: RunTemplate = {
  id: "tpl-refund-review",
  name: "Refund review (EMEA)",
  owner: "user:maya",
  agent: "refund-review@v1",
  params: {
    model: "stub-model",
    prompt: "review pending refunds",
    input: { region: "EMEA" },
    approvalTtlMs: 3_600_000,
    standingGrantId: "grant-refund-emea",
  },
  grants: [
    { principal: "user:editor", access: "edit" },
    { principal: "user:hook", access: "trigger" },
    { principal: "user:viewer", access: "view" },
  ],
  rev: 0,
};

const TRIGGER: WebhookTrigger = {
  id: "hook-refund-1",
  templateId: TEMPLATE.id,
  secret: "webhook-secret-0123456789abcdef",
  enabled: true,
  createdBy: "user:hook",
};

describe("run templates (ticket 023)", () => {
  it("access matrix: owner everything; edit implies view; trigger is NEVER implied", () => {
    for (const action of ["view", "edit", "trigger"] as const) {
      expect(canOnTemplate(TEMPLATE, "user:maya", action)).toBe(true);
    }
    expect(canOnTemplate(TEMPLATE, "user:editor", "view")).toBe(true);
    expect(canOnTemplate(TEMPLATE, "user:editor", "edit")).toBe(true);
    expect(canOnTemplate(TEMPLATE, "user:editor", "trigger")).toBe(false); // edit ≠ fire
    expect(canOnTemplate(TEMPLATE, "user:hook", "trigger")).toBe(true);
    expect(canOnTemplate(TEMPLATE, "user:hook", "edit")).toBe(false);
    expect(canOnTemplate(TEMPLATE, "user:viewer", "edit")).toBe(false);
    expect(canOnTemplate(TEMPLATE, "user:stranger", "view")).toBe(false);
  });

  it("property: no grant combination ever yields trigger without an explicit trigger grant", () => {
    const accessArb = fc.constantFrom<TemplateAccess>("view", "edit", "trigger");
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ principal: fc.constantFrom("user:a", "user:b"), access: accessArb }),
          { maxLength: 6 },
        ),
        fc.constantFrom("user:a", "user:b"),
        (grants, principal) => {
          const template: RunTemplate = { ...TEMPLATE, grants };
          const explicit = grants.some(
            (g) => g.principal === principal && g.access === "trigger",
          );
          expect(canOnTemplate(template, principal, "trigger")).toBe(explicit);
        },
      ),
    );
  });

  it("store: create validates, update is edit-gated and bumps rev, listFor sees grants", async () => {
    const store = new InMemoryTemplateStore();
    expect((await store.create(TEMPLATE)).ok).toBe(true);
    expect((await store.create(TEMPLATE)).ok).toBe(false); // duplicate
    const { name: _n, ...missingName } = TEMPLATE;
    expect((await store.create({ ...missingName, id: "t2" } as RunTemplate)).ok).toBe(false);

    const denied = await store.update(TEMPLATE.id, "user:hook", { name: "renamed" });
    expect(denied).toEqual({ ok: false, error: "forbidden" }); // trigger ≠ edit
    const updated = await store.update(TEMPLATE.id, "user:editor", { name: "renamed" });
    expect(updated.ok && updated.template.rev).toBe(1);
    expect(updated.ok && updated.template.name).toBe("renamed");

    expect((await store.listFor("user:viewer")).map((t) => t.id)).toEqual([TEMPLATE.id]);
    expect(await store.listFor("user:stranger")).toEqual([]);
  });
});

describe("webhook triggers (ticket 023)", () => {
  it("signature round-trip verifies; disabled and missing/tampered signatures are typed", () => {
    const body = '{"ticket":4821,"status":"escalated"}';
    const signature = signWebhook(TRIGGER.secret, body);
    expect(verifyWebhook(TRIGGER, body, signature)).toEqual({ ok: true });
    expect(verifyWebhook(TRIGGER, body, null)).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyWebhook(TRIGGER, `${body} `, signature)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhook({ ...TRIGGER, enabled: false }, body, signature)).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("property: any single-character tamper of body or signature is rejected", () => {
    const body = '{"event":"refund.requested","amount":120}';
    const signature = signWebhook(TRIGGER.secret, body);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: signature.length - 1 }),
        fc.constantFrom(..."0123456789abcdefXYZ"),
        (index, replacement) => {
          fc.pre(signature[index] !== replacement);
          const tampered = signature.slice(0, index) + replacement + signature.slice(index + 1);
          expect(verifyWebhook(TRIGGER, body, tampered).ok).toBe(false);
        },
      ),
    );
  });

  it("registration requires trigger access; disable is one call and sticks", async () => {
    const store = new InMemoryTriggerStore();
    const foreign = { ...TRIGGER, id: "hook-2", createdBy: "user:editor" }; // edit ≠ trigger
    expect(await store.create(foreign, TEMPLATE)).toEqual({ ok: false, error: "forbidden" });
    const mismatched = { ...TRIGGER, id: "hook-3", templateId: "other-template" };
    expect((await store.create(mismatched, TEMPLATE)).ok).toBe(false);

    expect((await store.create(TRIGGER, TEMPLATE)).ok).toBe(true);
    expect((await store.create(TRIGGER, TEMPLATE)).ok).toBe(false); // duplicate id

    const disabled = await store.disable(TRIGGER.id);
    expect(disabled.ok && disabled.trigger.enabled).toBe(false);
    expect((await store.get(TRIGGER.id))?.enabled).toBe(false);
    expect((await store.listForTemplate(TEMPLATE.id)).map((t) => t.id)).toEqual([TRIGGER.id]);
    expect(await store.disable("ghost")).toEqual({ ok: false, error: "not_found" });
  });
});
