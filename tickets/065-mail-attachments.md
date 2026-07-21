# 065 — Mail attachments: the invoice is IN the email

**Packages:** `apps/worker` · **Depends on:** 058, 061, 062 · **Allowed deps:** none new

## Context
The mailbox connector reads bodies; real department mail carries its payload in attachments —
the invoice PDF, the register spreadsheet. Deferred from 058, and now cheap: the extractors
already exist (061 PDF, 062 XLSX, 057 text caps). This ticket lists attachments on read and
adds one governed fetch that runs an attachment through the SAME extraction pipeline, caps,
and provenance labels as the file connector. No write surface, no new deps, deny-by-default
on anything we cannot parse.

## Scope
1. `mail.read@v1` output gains an additive optional `attachments` array: `{ index, filename,
   mimeType, sizeBytes }` — metadata only, never content; the `MailboxClient` seam and the
   imapflow implementation both learn to enumerate parts (hermetic tests stay hermetic).
2. New contract `mail.attachment@v1` (risk **read**, same egress as the mailbox): args
   `{ uid, index, mailbox? }` (uid — the connector's existing message key), output
   `{ filename, text, truncated, note?, provenance }` (docs.read's field names). The raw bytes are
   fetched via the seam, then routed by extension exactly like `docs.read`: `.pdf` → the 061
   extractor (incl. the no-text-layer note), `.xlsx` → the 062 reader rendered as CSV-ish
   text, text types → the 057 byte cap. Everything else refuses typed ("cannot extract
   <ext>") — deny-by-default, no raw-bytes passthrough.
3. Caps: the 4 MiB pre-parse byte cap applies to the FETCHED size before any parser runs;
   output is capped like `docs.read` with `truncated`. Secrets doctrine unchanged: the IMAP
   URL never appears in errors (058's scrubbing covers the new paths).
4. Provenance: attachment content is `provenance: "external"` like every mail/file read
   (CLAUDE.md rule 6).
5. Config: no new config surface — `mail.attachment` enables with the mailbox tools when
   `mailTools` is configured, granted per agent like any tool. The mailbox-triage template
   gains the tool with risk `read`.
6. Refactor allowed within `apps/worker`: lift the 061/062 extractors out of `files.ts` into
   a shared module both connectors import — behavior-identical, existing tests keep passing
   unmodified except import paths.
7. Tests: hermetic `MailboxClient` fixtures carrying a real PDF/XLSX/text/unknown attachment;
   metadata listing; extraction parity with the file connector; oversized and unknown-type
   refusals; URL scrubbing on the new failure paths.

## Out of scope
Sending attachments, OAuth mailboxes, inline images/multipart-alternative subtleties beyond
what part enumeration needs, OCR, archive formats (`.zip` refuses like any unknown type),
the live-mail drill (stays a HUMAN row).

## Acceptance criteria
- [ ] `mail.read` lists attachment metadata; old-shape outputs (no attachments) remain valid.
- [ ] `mail.attachment` extracts PDF/XLSX/text attachments with the file connector's exact
      caps and notes; unknown types and oversized payloads refuse typed (tested per case).
- [ ] The IMAP URL appears in no error message on any new path (tested).
- [ ] `pnpm test` and `pnpm build` green.
