# 051 — Approval notifications: the webhook floor for "somebody should know"

**Packages:** `apps/worker` · **Depends on:** 017, 048, 050 · **Allowed deps:** none new

## Context
048/050 made attention-routing a fact in the log; this ticket makes it reach a human. The log stays the contract — notifications are a best-effort SIDE CHANNEL that must never alter a run's course. The self-hostable floor every client can wire (Slack, Teams, PagerDuty, an internal bus all speak it): a plain webhook. Config names the URL's env var (the URL often embeds a token — it IS a secret); the payload carries facts already in the event log, nothing else.

## Scope
1. `NOTIFICATIONS_CONFIG` (zod, `.strict()`): `{ webhookUrlEnv, events?: ["approval_requested","approval_escalated","approval_delegated"] (default all three), timeoutMs? (default 3000) }`. Named-but-empty URL env refuses boot (the 036 rule). No config = no notifications, byte-identical.
2. `apps/worker/src/notify.ts`: `makeNotifier(config, env, fetchFn)` → `notify(event)` — POSTs `{ event, runId, agent, approverGroup?, toGroup?, toPrincipal?, expiresAt? }` (log-derivable facts ONLY; never args, prompts, or results — CLAUDE.md #4/#6 both bite here). Fire-and-forget with the timeout: failures and non-2xx are logged (URL never printed) and NEVER fail, retry, or delay the activity — at-most-once by design, the log remains the source of truth.
3. Wiring: the activities that append `ApprovalRequested` / `ApprovalEscalated` call `notify` after a successful, non-deduped append (an activity retry that deduped its append must not re-notify). Tenant lanes reuse the shared notifier in this slice (per-tenant `notifications.<id>.config.json` is one resolveLaneConfig call away — noted, not built).
4. Tests (injected fetch, no network): payload shape per event type incl. the never-carries-args scan; dedup — a retried append that returns `deduped` sends nothing; webhook 500/timeout/throw → run unaffected, failure logged without the URL; events filter respected; named-but-empty boot refusal; no-config = zero calls.
5. `deploy/`: `.env.example` documents `NOTIFICATIONS_CONFIG` + the URL env convention; compose passes it through.

## Out of scope
Delivery guarantees/queues (the log is the retry source — a client wanting exactly-once drains the audit export), per-tenant notifier configs (seeded), templating/formatting (the receiver's job), inbound webhooks.

## Acceptance criteria
- [ ] Notifications fire on requested/escalated/delegated appends — and never on deduped retries (test-pinned).
- [ ] Payloads carry log-derivable facts only; tool args/prompts/results never ride (scanned); the URL appears in no log or error.
- [ ] Webhook failure of any kind leaves the run byte-identical (typed logging only).
- [ ] No config = no behavior change; named-but-empty refuses boot.
- [ ] `pnpm test` and `pnpm build` green.
