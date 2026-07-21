import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@platform/policy";
import { createToolGateway } from "@platform/tool-gateway";
import {
  MAIL_ATTACHMENT_CAP_BYTES,
  MAIL_BODY_CAP_BYTES,
  MAIL_SEARCH_CAP,
  mailAttachmentExecutor,
  mailReadExecutor,
  mailSearchExecutor,
  mailSendExecutor,
  recipientRefusal,
  scrubbed,
} from "../src/tools/mail.js";
import type {
  MailAttachmentMeta,
  MailboxClient,
  MailEnvelope,
  MailSender,
} from "../src/tools/mail.js";
import { PDF_NO_TEXT_NOTE } from "../src/tools/files.js";
import { buildTools } from "../src/tools-config.js";

// Ticket 058: the email connector, hermetic. Reads are envelopes and capped
// provenance-labeled bodies; the ONE write is gated by prod approval AND a
// deny-by-default recipient allowlist; the connection URL is a secret that
// never leaves an error message intact.

const SECRET_URL = "imaps://bot:hunter2@mail.internal:993";

function fakeMailbox(messages: (MailEnvelope & { text: string })[]): MailboxClient & {
  searchCalls: { mailbox: string; limit: number }[];
} {
  const searchCalls: { mailbox: string; limit: number }[] = [];
  return {
    searchCalls,
    async search(mailbox, _query, limit) {
      searchCalls.push({ mailbox, limit });
      return messages.slice(0, limit).map(({ text: _text, ...envelope }) => envelope);
    },
    async read(_mailbox, uid) {
      const found = messages.find((m) => m.uid === uid);
      if (!found) throw new Error(`connect failed for ${SECRET_URL}`);
      return found;
    },
  };
}

function fakeSender(): MailSender & { sent: { to: string; subject: string }[] } {
  const sent: { to: string; subject: string }[] = [];
  return {
    sent,
    async send(to, subject) {
      sent.push({ to, subject });
    },
  };
}

const MESSAGES = [
  { uid: 7, from: "vendor@dune.example", subject: "rate change", date: "2026-06-01T00:00:00.000Z", text: "new rate applies" },
  { uid: 8, from: "hr@corp.example", subject: "policy", date: "2026-06-02T00:00:00.000Z", text: "x".repeat(MAIL_BODY_CAP_BYTES + 50) },
];

describe("mail read tools (ticket 058)", () => {
  it("search returns envelopes ONLY, defaults to INBOX, and clamps the limit", async () => {
    const mailbox = fakeMailbox(MESSAGES);
    const result = (await mailSearchExecutor(mailbox).execute({ limit: 999 } as never, {} as never)) as {
      envelopes: Record<string, unknown>[];
      provenance: string;
    };
    expect(mailbox.searchCalls[0]).toEqual({ mailbox: "INBOX", limit: MAIL_SEARCH_CAP });
    expect(result.provenance).toBe("external");
    expect(Object.keys(result.envelopes[0]!).sort()).toEqual(["date", "from", "subject", "uid"]);
    expect(JSON.stringify(result)).not.toContain("new rate"); // no bodies in search
  });

  it("read caps the body and labels it external", async () => {
    const read = mailReadExecutor(fakeMailbox(MESSAGES));
    const small = (await read.execute({ uid: 7 }, {} as never)) as { text: string; truncated: boolean; provenance: string };
    expect(small).toMatchObject({ text: "new rate applies", truncated: false, provenance: "external" });
    const big = (await read.execute({ uid: 8 }, {} as never)) as { text: string; truncated: boolean };
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.text, "utf8")).toBe(MAIL_BODY_CAP_BYTES);
  });

  it("the connection URL never survives into an error message", async () => {
    await expect(
      scrubbed(SECRET_URL, async () => {
        throw new Error(`connect failed for ${SECRET_URL}`);
      }),
    ).rejects.toThrow(/<mail-url>/);
    await expect(
      scrubbed(SECRET_URL, async () => {
        throw new Error(`connect failed for ${SECRET_URL}`);
      }),
    ).rejects.not.toThrow(/hunter2/);
  });
});

describe("mail attachments (ticket 065)", () => {
  const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

  function attachingMailbox(
    files: { filename: string; bytes: Buffer }[],
  ): MailboxClient {
    const metas: MailAttachmentMeta[] = files.map((file, index) => ({
      index,
      filename: file.filename,
      mimeType: "application/octet-stream",
      sizeBytes: file.bytes.length,
    }));
    return {
      async search() {
        return [];
      },
      async read(_mailbox, uid) {
        return {
          uid,
          from: "vendor@dune.example",
          subject: "invoices attached",
          date: "2026-06-01T00:00:00.000Z",
          text: "see attached",
          ...(metas.length > 0 ? { attachments: metas } : {}),
        };
      },
      async fetchAttachment(_mailbox, _uid, index) {
        const file = files[index];
        if (!file) throw new Error(`connect failed for ${SECRET_URL}`);
        return { meta: metas[index]!, bytes: file.bytes };
      },
    };
  }

  it("mail.read lists attachment metadata; a mailbox without attachments keeps the old shape", async () => {
    const withAttachment = attachingMailbox([
      { filename: "invoice.pdf", bytes: Buffer.from("stub") },
    ]);
    const read = (await mailReadExecutor(withAttachment).execute({ uid: 7 }, {} as never)) as {
      attachments?: MailAttachmentMeta[];
    };
    expect(read.attachments).toEqual([
      { index: 0, filename: "invoice.pdf", mimeType: "application/octet-stream", sizeBytes: 4 },
    ]);
    // the 058-era fake has no attachment surface at all — output unchanged
    const old = (await mailReadExecutor(fakeMailbox(MESSAGES)).execute({ uid: 7 }, {} as never)) as
      Record<string, unknown>;
    expect("attachments" in old).toBe(false);
  });

  it("extracts a PDF attachment with the file connector's extractor; textless PDFs carry the note", async () => {
    const pdf = await readFile(`${fixturesDir}/fixture-061.pdf`);
    const notext = await readFile(`${fixturesDir}/fixture-061-notext.pdf`);
    const executor = mailAttachmentExecutor(
      attachingMailbox([
        { filename: "invoice.pdf", bytes: pdf },
        { filename: "scan.pdf", bytes: notext },
      ]),
    );
    const extracted = (await executor.execute({ uid: 7, index: 0 }, {} as never)) as {
      filename: string;
      text: string;
      provenance: string;
    };
    expect(extracted.filename).toBe("invoice.pdf");
    expect(extracted.text).toContain("PLATFORM PDF FIXTURE 061");
    expect(extracted.provenance).toBe("external");

    const scanned = (await executor.execute({ uid: 7, index: 1 }, {} as never)) as {
      text: string;
      note?: string;
    };
    expect(scanned.text).toBe("");
    expect(scanned.note).toBe(PDF_NO_TEXT_NOTE);
  });

  it("extracts an .xlsx attachment as escaped CSV text — formula results included", async () => {
    const xlsx = await readFile(`${fixturesDir}/fixture-062.xlsx`);
    const executor = mailAttachmentExecutor(
      attachingMailbox([{ filename: "register.xlsx", bytes: xlsx }]),
    );
    const result = (await executor.execute({ uid: 7, index: 0 }, {} as never)) as { text: string };
    const lines = result.text.split("\n");
    expect(lines[0]).toContain("invoice");
    expect(result.text).toContain("INV-2001");
    expect(result.text).toContain("1575.525"); // the formula's cached RESULT
  });

  it("text attachments decode as-is; unknown types, oversized payloads, and missing indexes refuse typed", async () => {
    const executor = mailAttachmentExecutor(
      attachingMailbox([
        { filename: "memo.txt", bytes: Buffer.from("plain memo") },
        { filename: "archive.zip", bytes: Buffer.from("PK") },
        { filename: "huge.pdf", bytes: Buffer.alloc(MAIL_ATTACHMENT_CAP_BYTES + 1) },
      ]),
    );
    const text = (await executor.execute({ uid: 7, index: 0 }, {} as never)) as { text: string };
    expect(text.text).toBe("plain memo");
    await expect(executor.execute({ uid: 7, index: 1 }, {} as never)).rejects.toThrow(
      /cannot extract \.zip/,
    );
    await expect(executor.execute({ uid: 7, index: 2 }, {} as never)).rejects.toThrow(/fetch cap/);
    await expect(executor.execute({ uid: 7, index: 9 }, {} as never)).rejects.toThrow(
      /connect failed/,
    );
  });

  it("the connection URL never survives the new failure paths either", async () => {
    await expect(
      scrubbed(SECRET_URL, async () => {
        throw new Error(`mail.attachment: download failed via ${SECRET_URL}`);
      }),
    ).rejects.not.toThrow(/hunter2/);
  });
});

describe("mail.send (ticket 058)", () => {
  it("deny by default: no allowlist refuses everything; wrong domain refused; right domain sends once", async () => {
    expect(recipientRefusal("a@corp.example", undefined)).toContain("denied by default");
    expect(recipientRefusal("a@corp.example", [])).toContain("denied by default");
    expect(recipientRefusal("a@evil.example", ["corp.example"])).toContain("evil.example");
    expect(recipientRefusal("a@CORP.example", ["corp.example"])).toBeNull();

    const sender = fakeSender();
    const send = mailSendExecutor(sender, ["corp.example"]);
    await expect(
      send.execute({ to: "x@evil.example", subject: "s", text: "t" }, {} as never),
    ).rejects.toThrow(/not in allowedRecipientDomains/);
    await send.execute({ to: "x@corp.example", subject: "s", text: "t" }, {} as never);
    expect(sender.sent).toEqual([{ to: "x@corp.example", subject: "s" }]);
  });
});

describe("boot wiring + governance (ticket 058)", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    tools: ["mail.search@v1", "mail.read@v1", "mail.attachment@v1", "mail.send@v1"],
    grants: [
      {
        agent: "mailer@v1",
        tools: [
          { name: "mail.read", version: "v1" },
          { name: "mail.send", version: "v1" },
        ],
      },
    ],
    mailTools: {
      imapUrlEnv: "MAIL_IMAP_URL",
      smtpUrlEnv: "MAIL_SMTP_URL",
      allowedRecipientDomains: ["corp.example"],
    },
    // the operator explicitly allowlists where mail flows — the gateway
    // refuses egress to unlisted hosts even for enabled tools
    egressAllowlist: ["mail.internal", "smtp.internal"],
    ...overrides,
  });
  const deps = () => ({
    env: { MAIL_IMAP_URL: SECRET_URL, MAIL_SMTP_URL: "smtp://bot:pw@smtp.internal:587" },
    mailClients: { mailbox: fakeMailbox(MESSAGES), sender: fakeSender() },
  });

  it("boots the four tools; refuses missing config, named-but-empty envs, and send without smtpUrlEnv", async () => {
    const built = await buildTools(config(), deps());
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.tools.registry.describeAll().map((t) => t.name).sort()).toEqual([
        "mail.attachment",
        "mail.read",
        "mail.search",
        "mail.send",
      ]);
    }

    expect(await buildTools(config({ mailTools: undefined }), deps())).toMatchObject({
      ok: false,
      error: expect.stringContaining("mailTools"),
    });
    expect(
      await buildTools(config(), { env: { MAIL_SMTP_URL: "smtp://x" } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("MAIL_IMAP_URL") });
    expect(
      await buildTools(
        config({ mailTools: { imapUrlEnv: "MAIL_IMAP_URL" } }),
        deps(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("smtpUrlEnv") });
    // the secret URL never appears in any boot error
    const failed = await buildTools(config(), { env: { MAIL_IMAP_URL: "" } });
    if (!failed.ok) expect(failed.error).not.toContain("hunter2");
  });

  it("environment split: mail.send PAUSES in prod, auto-executes in dev; reads execute in prod", async () => {
    const intent = {
      runId: "run-mail",
      agent: "mailer@v1",
      principal: "user:test",
      intent: {
        tool: "mail.send",
        version: "v1",
        args: { to: "x@corp.example", subject: "hi", text: "t" },
      },
    };
    const built = await buildTools(config(), deps());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const prod = createToolGateway({ ...built.tools, rules: DEFAULT_RULES, env: "prod" });
    expect((await prod.handleIntent(intent)).kind).toBe("approval_required");

    const read = await prod.handleIntent({
      ...intent,
      intent: { tool: "mail.read", version: "v1", args: { uid: 7 } },
    });
    expect(read.kind).toBe("executed");

    const dev = createToolGateway({ ...built.tools, rules: DEFAULT_RULES, env: "dev" });
    expect((await dev.handleIntent(intent)).kind).toBe("executed");

    // the allowlist refusal is a typed execution failure, audited like any
    const refused = await dev.handleIntent({
      ...intent,
      intent: { tool: "mail.send", version: "v1", args: { to: "x@evil.example", subject: "s", text: "t" } },
    });
    expect(refused.kind).toBe("refused");
  });
});
