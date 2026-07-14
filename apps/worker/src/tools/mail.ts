import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { ToolContract } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";

// Email connector (ticket 058). Reads are envelopes-and-capped-bodies only;
// the ONE write — mail.send — goes through the full gateway (prod approval)
// AND a recipient-domain allowlist, deny-by-default. Mailbox content is the
// textbook injection surface: everything read is provenance-labeled external
// data (CLAUDE.md #6). Servers are client-provided IMAP/SMTP (CLAUDE.md #8);
// the connection URLs embed credentials and are treated as secrets — they
// live in executor closures and are scrubbed from every error that leaves.

export const MAIL_SEARCH_CAP = 20;
export const MAIL_BODY_CAP_BYTES = 64 * 1024;

export const mailSearchContract = (egress: string[]): ToolContract => ({
  name: "mail.search",
  version: "v1",
  description: "Search the configured mailbox; returns envelopes only, never bodies.",
  risk: "read",
  input: z
    .object({
      mailbox: z.string().min(1).max(200).optional(),
      query: z.string().min(1).max(500).optional(),
      limit: z.number().int().positive().max(MAIL_SEARCH_CAP).optional(),
    })
    .strict(),
  output: z
    .object({
      envelopes: z.array(
        z
          .object({ uid: z.number().int(), from: z.string(), subject: z.string(), date: z.string() })
          .strict(),
      ),
      provenance: z.literal("external"),
    })
    .strict(),
  egress,
});

export const mailReadContract = (egress: string[]): ToolContract => ({
  name: "mail.read",
  version: "v1",
  description: "Read one message's text body (capped) from the configured mailbox.",
  risk: "read",
  input: z.object({ uid: z.number().int().positive(), mailbox: z.string().min(1).max(200).optional() }).strict(),
  output: z
    .object({
      uid: z.number().int(),
      from: z.string(),
      subject: z.string(),
      date: z.string(),
      text: z.string(),
      truncated: z.boolean(),
      provenance: z.literal("external"),
    })
    .strict(),
  egress,
});

export const mailSendContract = (egress: string[]): ToolContract => ({
  name: "mail.send",
  version: "v1",
  description: "Send one plain-text email (governed write; recipient domain must be allowlisted).",
  risk: "write",
  input: z
    .object({
      to: z.string().email().max(320),
      subject: z.string().min(1).max(500),
      text: z.string().min(1).max(50_000),
    })
    .strict(),
  output: z.object({ to: z.string(), sent: z.literal(true) }).strict(),
  egress,
});

export interface MailEnvelope {
  uid: number;
  from: string;
  subject: string;
  date: string;
}

/** Hermetic seam: tests inject fakes; production builds from the env URLs. */
export interface MailboxClient {
  search(mailbox: string, query: string | undefined, limit: number): Promise<MailEnvelope[]>;
  read(mailbox: string, uid: number): Promise<MailEnvelope & { text: string }>;
}

export interface MailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** The URL (user:pass@host) must never leave the closure — every error is
 * re-thrown with the secret replaced, notify.ts-style. */
export function scrubbed<T>(secret: string, run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    const message = String((error as Error)?.message ?? error).split(secret).join("<mail-url>");
    throw new Error(message);
  });
}

export function hostOf(url: string): string {
  return new URL(url).hostname;
}

export function makeImapMailbox(imapUrl: string): MailboxClient {
  const parsed = new URL(imapUrl);
  const open = async (): Promise<ImapFlow> => {
    const client = new ImapFlow({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 993,
      secure: parsed.protocol !== "imap:",
      auth: {
        user: decodeURIComponent(parsed.username),
        pass: decodeURIComponent(parsed.password),
      },
      logger: false, // imapflow's default logger would print the connection
    });
    await client.connect();
    return client;
  };
  return {
    search: (mailbox, query, limit) =>
      scrubbed(imapUrl, async () => {
        const client = await open();
        try {
          const lock = await client.getMailboxLock(mailbox);
          try {
            const uids = await client.search(
              query === undefined ? { all: true } : { or: [{ subject: query }, { from: query }] },
              { uid: true },
            );
            const picked = (uids || []).slice(-limit).reverse();
            const envelopes: MailEnvelope[] = [];
            for (const uid of picked) {
              const message = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
              if (!message || message.envelope === undefined) continue;
              envelopes.push({
                uid,
                from: message.envelope.from?.[0]?.address ?? "(unknown)",
                subject: message.envelope.subject ?? "(no subject)",
                date: message.envelope.date?.toISOString() ?? "",
              });
            }
            return envelopes;
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => {});
        }
      }),
    read: (mailbox, uid) =>
      scrubbed(imapUrl, async () => {
        const client = await open();
        try {
          const lock = await client.getMailboxLock(mailbox);
          try {
            const message = await client.fetchOne(
              String(uid),
              { envelope: true, bodyParts: ["text"] },
              { uid: true },
            );
            if (!message || message.envelope === undefined) {
              throw new Error(`mail.read: no message with uid ${uid} in ${mailbox}`);
            }
            const body = message.bodyParts?.get("text")?.toString("utf8") ?? "";
            return {
              uid,
              from: message.envelope.from?.[0]?.address ?? "(unknown)",
              subject: message.envelope.subject ?? "(no subject)",
              date: message.envelope.date?.toISOString() ?? "",
              text: body,
            };
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => {});
        }
      }),
  };
}

export function makeSmtpSender(smtpUrl: string): MailSender {
  const transport = nodemailer.createTransport(smtpUrl);
  const from = new URL(smtpUrl);
  return {
    send: (to, subject, text) =>
      scrubbed(smtpUrl, async () => {
        await transport.sendMail({
          from: decodeURIComponent(from.username) || undefined,
          to,
          subject,
          text,
        });
      }),
  };
}

export function mailSearchExecutor(mailbox: MailboxClient): ToolExecutor {
  return {
    ref: { name: "mail.search", version: "v1" },
    async execute(args) {
      const { mailbox: box, query, limit } = args as {
        mailbox?: string;
        query?: string;
        limit?: number;
      };
      const envelopes = await mailbox.search(
        box ?? "INBOX",
        query,
        Math.min(limit ?? MAIL_SEARCH_CAP, MAIL_SEARCH_CAP),
      );
      return { envelopes, provenance: "external" as const };
    },
  };
}

export function mailReadExecutor(mailbox: MailboxClient): ToolExecutor {
  return {
    ref: { name: "mail.read", version: "v1" },
    async execute(args) {
      const { uid, mailbox: box } = args as { uid: number; mailbox?: string };
      const message = await mailbox.read(box ?? "INBOX", uid);
      const bytes = Buffer.byteLength(message.text, "utf8");
      const truncated = bytes > MAIL_BODY_CAP_BYTES;
      const text = truncated
        ? Buffer.from(message.text, "utf8").subarray(0, MAIL_BODY_CAP_BYTES).toString("utf8")
        : message.text;
      return {
        uid: message.uid,
        from: message.from,
        subject: message.subject,
        date: message.date,
        text,
        truncated,
        provenance: "external" as const,
      };
    },
  };
}

/** Deny by default: no allowlist means NO recipient is legal, said plainly. */
export function recipientRefusal(to: string, allowedDomains: readonly string[] | undefined): string | null {
  const domain = to.slice(to.lastIndexOf("@") + 1).toLowerCase();
  if (allowedDomains === undefined || allowedDomains.length === 0) {
    return "mail.send refused: no allowedRecipientDomains configured — all sends are denied by default";
  }
  if (!allowedDomains.some((allowed) => allowed.toLowerCase() === domain)) {
    return `mail.send refused: recipient domain ${domain} is not in allowedRecipientDomains`;
  }
  return null;
}

export function mailSendExecutor(
  sender: MailSender,
  allowedDomains: readonly string[] | undefined,
): ToolExecutor {
  return {
    ref: { name: "mail.send", version: "v1" },
    async execute(args) {
      const { to, subject, text } = args as { to: string; subject: string; text: string };
      const refusal = recipientRefusal(to, allowedDomains);
      if (refusal !== null) throw new Error(refusal);
      await sender.send(to, subject, text);
      return { to, sent: true as const };
    },
  };
}
