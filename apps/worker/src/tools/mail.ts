import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { ToolContract } from "@platform/tool-registry";
import type { ToolExecutor } from "@platform/tool-gateway";
import {
  capUtf8,
  extractPdfTextFromBytes,
  PDF_NO_TEXT_NOTE,
  readXlsxFromBytes,
  renderTableAsCsv,
  SHEET_ROW_CAP,
  TEXT_EXTENSIONS,
} from "./extract.js";

// Email connector (ticket 058). Reads are envelopes-and-capped-bodies only;
// the ONE write — mail.send — goes through the full gateway (prod approval)
// AND a recipient-domain allowlist, deny-by-default. Mailbox content is the
// textbook injection surface: everything read is provenance-labeled external
// data (CLAUDE.md #6). Servers are client-provided IMAP/SMTP (CLAUDE.md #8);
// the connection URLs embed credentials and are treated as secrets — they
// live in executor closures and are scrubbed from every error that leaves.

export const MAIL_SEARCH_CAP = 20;
export const MAIL_BODY_CAP_BYTES = 64 * 1024;
/** Ticket 065: fetched attachment bytes are capped BEFORE any parser runs. */
export const MAIL_ATTACHMENT_CAP_BYTES = 4 * 1024 * 1024;
/** …and the extracted text leaves with the file connector's read cap. */
export const MAIL_ATTACHMENT_TEXT_CAP_BYTES = 256 * 1024;

const attachmentMetaSchema = z
  .object({
    index: z.number().int().nonnegative(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

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
      /** Ticket 065, additive: metadata only — content goes through
       * mail.attachment@v1, never inline. */
      attachments: z.array(attachmentMetaSchema).optional(),
    })
    .strict(),
  egress,
});

export const mailAttachmentContract = (egress: string[]): ToolContract => ({
  name: "mail.attachment",
  version: "v1",
  description:
    "Extract one attachment's content (.pdf/.xlsx/text types) from a message in the configured mailbox.",
  risk: "read",
  input: z
    .object({
      uid: z.number().int().positive(),
      index: z.number().int().nonnegative(),
      mailbox: z.string().min(1).max(200).optional(),
    })
    .strict(),
  output: z
    .object({
      filename: z.string(),
      text: z.string(),
      truncated: z.boolean(),
      provenance: z.literal("external"),
      /** Set for exactly one case — a parseable PDF with no text layer. */
      note: z.string().optional(),
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

export interface MailAttachmentMeta {
  index: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Hermetic seam: tests inject fakes; production builds from the env URLs.
 * `attachments` on read and `fetchAttachment` are optional so pre-065 fakes
 * stay valid — a mailbox without them simply has no attachment surface. */
export interface MailboxClient {
  search(mailbox: string, query: string | undefined, limit: number): Promise<MailEnvelope[]>;
  read(
    mailbox: string,
    uid: number,
  ): Promise<MailEnvelope & { text: string; attachments?: MailAttachmentMeta[] }>;
  fetchAttachment?(
    mailbox: string,
    uid: number,
    index: number,
  ): Promise<{ meta: MailAttachmentMeta; bytes: Buffer }>;
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

interface BodyStructureNode {
  part?: string;
  type?: string;
  disposition?: string;
  size?: number;
  parameters?: { name?: string };
  dispositionParameters?: { filename?: string };
  childNodes?: BodyStructureNode[];
}

/** Attachment parts in a stable order: disposition says attachment, or a
 * filename is declared — the main text body never qualifies. */
export function collectAttachmentParts(node: BodyStructureNode): BodyStructureNode[] {
  const out: BodyStructureNode[] = [];
  const visit = (current: BodyStructureNode): void => {
    const filename = current.dispositionParameters?.filename ?? current.parameters?.name;
    if (current.disposition === "attachment" || (filename !== undefined && current.part !== undefined)) {
      out.push(current);
    } else {
      for (const child of current.childNodes ?? []) visit(child);
    }
  };
  for (const child of node.childNodes ?? [node]) visit(child);
  return out;
}

function metaOf(node: BodyStructureNode, index: number): MailAttachmentMeta {
  return {
    index,
    filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? "(unnamed)",
    mimeType: node.type ?? "application/octet-stream",
    sizeBytes: node.size ?? 0,
  };
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
              { envelope: true, bodyParts: ["text"], bodyStructure: true },
              { uid: true },
            );
            if (!message || message.envelope === undefined) {
              throw new Error(`mail.read: no message with uid ${uid} in ${mailbox}`);
            }
            const body = message.bodyParts?.get("text")?.toString("utf8") ?? "";
            const parts = message.bodyStructure
              ? collectAttachmentParts(message.bodyStructure as BodyStructureNode)
              : [];
            return {
              uid,
              from: message.envelope.from?.[0]?.address ?? "(unknown)",
              subject: message.envelope.subject ?? "(no subject)",
              date: message.envelope.date?.toISOString() ?? "",
              text: body,
              ...(parts.length > 0 ? { attachments: parts.map(metaOf) } : {}),
            };
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => {});
        }
      }),
    fetchAttachment: (mailbox, uid, index) =>
      scrubbed(imapUrl, async () => {
        const client = await open();
        try {
          const lock = await client.getMailboxLock(mailbox);
          try {
            const message = await client.fetchOne(
              String(uid),
              { bodyStructure: true },
              { uid: true },
            );
            if (!message || message.bodyStructure === undefined) {
              throw new Error(`mail.attachment: no message with uid ${uid} in ${mailbox}`);
            }
            const parts = collectAttachmentParts(message.bodyStructure as BodyStructureNode);
            const part = parts[index];
            if (part?.part === undefined) {
              throw new Error(
                `mail.attachment: message ${uid} has no attachment at index ${index} (found ${parts.length})`,
              );
            }
            const download = await client.download(String(uid), part.part, { uid: true });
            const chunks: Buffer[] = [];
            for await (const chunk of download.content) {
              chunks.push(chunk as Buffer);
            }
            return { meta: metaOf(part, index), bytes: Buffer.concat(chunks) };
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
      const { text, truncated } = capUtf8(message.text, MAIL_BODY_CAP_BYTES);
      return {
        uid: message.uid,
        from: message.from,
        subject: message.subject,
        date: message.date,
        text,
        truncated,
        provenance: "external" as const,
        ...(message.attachments !== undefined && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      };
    },
  };
}

/** Ticket 065: one attachment through the SAME extraction pipeline, caps,
 * and refusal shapes as the file connector — deny-by-default on anything
 * that is not a PDF, workbook, or plain-text type. */
export function mailAttachmentExecutor(mailbox: MailboxClient): ToolExecutor {
  return {
    ref: { name: "mail.attachment", version: "v1" },
    async execute(args) {
      const { uid, index, mailbox: box } = args as { uid: number; index: number; mailbox?: string };
      if (mailbox.fetchAttachment === undefined) {
        throw new Error("mail.attachment refused: this mailbox client cannot fetch attachments");
      }
      const { meta, bytes } = await mailbox.fetchAttachment(box ?? "INBOX", uid, index);
      if (bytes.length > MAIL_ATTACHMENT_CAP_BYTES) {
        throw new Error(
          `mail.attachment refused: attachment is ${bytes.length} bytes; the fetch cap is ${MAIL_ATTACHMENT_CAP_BYTES}`,
        );
      }
      const filename = meta.filename;
      const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();

      let extracted: string;
      let note: string | undefined;
      if (extension === ".pdf") {
        extracted = await extractPdfTextFromBytes(bytes, "mail.attachment");
        if (extracted === "") note = PDF_NO_TEXT_NOTE;
      } else if (extension === ".xlsx") {
        const table = await readXlsxFromBytes(bytes, SHEET_ROW_CAP, "mail.attachment");
        extracted = renderTableAsCsv(table);
      } else if (TEXT_EXTENSIONS.includes(extension)) {
        extracted = bytes.toString("utf8");
      } else {
        throw new Error(
          `mail.attachment refused: cannot extract ${extension || "extension-less"} attachments (pdf/xlsx/${TEXT_EXTENSIONS.join("/")} only)`,
        );
      }

      const { text, truncated } = capUtf8(extracted, MAIL_ATTACHMENT_TEXT_CAP_BYTES);
      return {
        filename,
        text,
        truncated,
        provenance: "external" as const,
        ...(note !== undefined ? { note } : {}),
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
