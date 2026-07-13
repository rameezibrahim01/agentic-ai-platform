import { z } from "zod";

// Approval notifications (ticket 051): a best-effort SIDE CHANNEL. The event
// log is the contract; this only makes it reach a human faster. The webhook
// URL comes from a NAMED env var (it usually embeds a token — it IS a
// secret) and appears in no log or error. Payloads carry log-derivable
// facts ONLY — never args, prompts, or results (CLAUDE.md #4/#6). Failures
// are logged and swallowed: a dead webhook never alters a run's course.

export const NOTIFICATION_EVENTS = [
  "approval_requested",
  "approval_escalated",
  "approval_delegated",
] as const;

export const notificationsConfigSchema = z
  .object({
    /** Env var NAME holding the webhook URL — never the URL itself. */
    webhookUrlEnv: z.string().min(1),
    events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).default([...NOTIFICATION_EVENTS]),
    timeoutMs: z.number().int().positive().default(3_000),
  })
  .strict();

export type NotificationsConfig = z.infer<typeof notificationsConfigSchema>;

export type Notification =
  | {
      event: "approval_requested";
      runId: string;
      agent: string;
      approverGroup: string;
      expiresAt: number;
    }
  | { event: "approval_escalated"; runId: string; agent: string; toGroup: string }
  | { event: "approval_delegated"; runId: string; agent: string; toPrincipal: string };

/** Fire-and-forget by type: no promise escapes, nothing to await or fail. */
export type Notifier = (notification: Notification) => void;

export const NO_NOTIFIER: Notifier = () => {};

export type MakeNotifierResult =
  | { ok: true; notifier: Notifier; summary: string }
  | { ok: false; error: string };

export function makeNotifier(
  rawConfig: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchFn: typeof fetch = fetch,
): MakeNotifierResult {
  const parsed = notificationsConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid NOTIFICATIONS_CONFIG: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const config = parsed.data;
  const url = env[config.webhookUrlEnv];
  if (!url) {
    return {
      ok: false,
      error: `NOTIFICATIONS_CONFIG names webhook env ${config.webhookUrlEnv} but it is empty`,
    };
  }
  const enabled = new Set(config.events);
  const notifier: Notifier = (notification) => {
    if (!enabled.has(notification.event)) return;
    void fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
      .then((response) => {
        if (!response.ok) {
          // the URL never prints — it is a secret
          console.warn(`notify: webhook returned HTTP ${response.status} for ${notification.event}`);
        }
      })
      .catch((error: unknown) => {
        console.warn(
          `notify: webhook unreachable for ${notification.event}: ${
            error instanceof Error ? error.name : "error"
          }`,
        );
      });
  };
  return {
    ok: true,
    notifier,
    summary: `notifications: ${config.events.join(", ")} → env ${config.webhookUrlEnv}`,
  };
}
