# 023 — Run templates + event triggers

**Packages:** new `packages/templates` (pure) + `apps/console` (webhook endpoint) + `apps/worker` (client glue) · **Depends on:** 010, 013, 020 · **Allowed deps:** none new

## Context
Architecture §3: invocations are configuration too. A **run template** binds an agent version to concrete parameters as a saved, shareable object with an owner and explicit share grants (view / edit / trigger) — "developer in the workspace" never silently means "may fire the refund agent." **Event triggers** attach templates to the world changing: a registered webhook starts a run when it fires, governed and audited exactly like any control-plane object. This is control-plane work, not engine work: the run that starts is an ordinary `agentRun`, and any standing authority still comes only from a 020 grant referenced by the template.

## Scope
1. `RunTemplate` in `packages/templates`: `{ id, name, owner, agent, params: { model, prompt, input, budget?, approvalTtlMs?, standingGrantId? }, grants: [{ principal, access: "view" | "edit" | "trigger" }] }` — zod-validated, `.strict()`. `canOnTemplate(template, principal, action)`: the owner can do everything; everyone else needs an explicit grant; `view < edit`, and **`trigger` is never implied** by edit.
2. `TemplateStore` (interface + in-memory, same shape discipline as `GrantStore`): `create` (validates), `get`, `update` (edit-gated by principal, bumps `rev`), `listFor(principal)` (owner or any grant).
3. `WebhookTrigger` in `packages/templates`: `{ id, templateId, secret, enabled, createdBy }`; `verifyWebhook(trigger, rawBody, signatureHeader, nowMs?)` — HMAC-SHA256 over the raw body, `sha256=<hex>` header form, `timingSafeEqual`, typed failures (`missing_signature` / `bad_signature` / `disabled`). `TriggerStore`: `create` (only by a principal with `trigger` access on the template), `get`, `disable` (permanent, like grant revocation).
4. `apps/console` endpoint `POST /api/hooks/[triggerId]`: verify signature over the raw body → look up trigger + template → start `agentRun` via the Temporal client with **workflowId = `hook-<triggerId>-<deliveryId>`** (delivery id from the `x-delivery` header; required) so redelivered webhooks dedupe to one run (003 idempotency). Template params become the run input; the webhook payload is carried as `input.event` — data, never instructions (CLAUDE.md #6). Refusals are typed JSON (401/403/404/409), and a disabled trigger refuses without touching Temporal.
5. Tests: grant-matrix property (only owner/edit may update, only owner/trigger may fire); signature round-trip + single-char tamper property; idempotent delivery (same delivery id → same workflowId); disabled-trigger refusal; endpoint auth surface unit-tested at the handler level with an injected client.

## Out of scope
Queue subscriptions, notification routing, template versioning UI, trigger management UI (registration is code/config for now), per-template schedules (010 owns schedules), Postgres persistence for the new stores.

## Acceptance criteria
- [ ] Templates carry owner + explicit view/edit/trigger grants; `canOnTemplate` enforces the matrix (property-tested) and `trigger` is never implied.
- [ ] Webhook deliveries: valid signature + enabled trigger + `trigger` access → run starts with the template's params and the payload under `input.event`; tampered/missing signature and disabled triggers are typed refusals with no run started.
- [ ] Redelivery of the same delivery id cannot start a second run (workflowId = `hook-<triggerId>-<deliveryId>`).
- [ ] A template referencing a `standingGrantId` threads it into the run input untouched — authority still resolves per-occurrence via 020.
- [ ] `pnpm test` and `pnpm build` green.
