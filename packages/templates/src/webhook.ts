import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Event triggers (architecture §3, ticket 023): a registered webhook starts
// a run when the world changes — governed and audited like any control-plane
// object. The delivery payload is DATA for the run's input, never
// instructions (CLAUDE.md #6); authenticity is an HMAC over the raw body.

export const webhookTriggerSchema = z
  .object({
    id: z.string().min(1),
    templateId: z.string().min(1),
    /** Shared with the sender; HMAC-SHA256 over the raw request body. */
    secret: z.string().min(16),
    enabled: z.boolean().default(true),
    /** The principal whose `trigger` access authorizes every delivery. */
    createdBy: z.string().min(1),
  })
  .strict();

export type WebhookTrigger = z.infer<typeof webhookTriggerSchema>;

/** `sha256=<hex>` — the conventional signature header form. */
export function signWebhook(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: "disabled" | "missing_signature" | "bad_signature" };

export function verifyWebhook(
  trigger: WebhookTrigger,
  rawBody: string,
  signatureHeader: string | null | undefined,
): WebhookVerification {
  if (!trigger.enabled) return { ok: false, reason: "disabled" };
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const presented = Buffer.from(signatureHeader, "utf8");
  const expected = Buffer.from(signWebhook(trigger.secret, rawBody), "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
