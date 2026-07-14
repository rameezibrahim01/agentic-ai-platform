# 058 — Email connector: read the mailbox, send only past the gateway

**Packages:** `apps/worker`, `deploy/` · **Depends on:** 016, 046 (named-env pattern), 057 · **Allowed deps:** `imapflow`, `nodemailer` (worker)

## Context
The second thing every department actually lives in. Reads (search, open a message) are risk
`read`; sending is the connector's ONE write and goes through the full gateway — intent,
policy, prod approval, audit — with a recipient-domain allowlist on top, because "the model
emailed the wrong person" is the failure mode everyone fears first. Mailbox content is the
textbook injection surface: everything read is provenance-labeled external data (CLAUDE.md #6)
and never treated as instructions. Servers are client-provided (IMAP/SMTP are the most
self-hostable protocols alive — CLAUDE.md #8); credentials ride the named-env-var pattern and
never appear anywhere but the connection itself.

## Scope
1. `toolsConfigSchema` gains `mailTools: { imapUrlEnv, smtpUrlEnv?, allowedRecipientDomains? }`
   (`.strict()`). Named-but-empty env refuses boot (046 rule); no `smtpUrlEnv` = read-only
   mailbox, `mail.send` does not exist. URLs (which embed credentials) are secrets: never in
   logs, events, errors, or boot summaries — scrubbed the way notify.ts scrubs webhook URLs.
2. `mail.search@v1` (risk read): `{mailbox?, query?, limit<=20}` → envelopes only (uid, from,
   subject, date) — bodies never ride a search result.
3. `mail.read@v1` (risk read): `{uid}` → text body, 64 KiB cap + `truncated` flag, payload
   wrapped `{provenance: "external", ...}` like retrieved documents.
4. `mail.send@v1` (risk **write**): `{to, subject, text}`; recipient domain must be in
   `allowedRecipientDomains` (absent list = refuse all sends — deny by default), refusals typed
   and audited; egress on the contract is derived from the SMTP host.
5. Executors take injected client factories (fake IMAP/SMTP in tests — hermetic, no network);
   real factories build from the env URLs at boot.
6. Deploy: `.env.example` + compose passthroughs (`MAIL_IMAP_URL`, `MAIL_SMTP_URL`), commented
   out by default — no mail config = no mail tools, byte-identical boot.
7. Tests: boot refusals (named-empty, bad URL), envelope-only search, body cap + provenance
   label, domain-allowlist refusal audited, dev-auto/prod-pause integration for `mail.send`,
   and a secrets-scan-style assertion that the URL never appears in any log/event/error text.

## Out of scope
OAuth mailboxes (client IdP-specific), attachments, HTML bodies, folder management, marking
read/moving messages, a live-server drill (needs a real mailbox — recorded as a HUMAN row).

## Acceptance criteria
- [ ] With `mailTools` configured, an agent can search envelopes and read a capped,
      provenance-labeled body; without it (or with SMTP unset), the absent tools do not exist.
- [ ] `mail.send` executes only after prod approval AND only to allowlisted domains; both
      refusal paths are typed and audited (tested).
- [ ] Named-but-empty env refuses boot; the connection URL never appears in logs, events,
      errors, or fixtures (asserted, secrets-scan style).
- [ ] All tests hermetic (injected fakes); `pnpm test`/`pnpm build` green.
