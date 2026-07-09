# Enterprise Agentic Platform — Phase-by-Phase Build Plan

Companion to the reference architecture. The architecture says *what*; this says *in what order, with what proof*.

## 0. Planning assumptions

This plan is written for a small founding team of 2–4 senior engineers working full-time (at minimum: one infra-leaning, one product-leaning). With fewer people the durations stretch roughly linearly but the sequence holds — nothing here reorders safely. A **design partner** — one company, one economically real workflow (a refund pipeline, a support triage queue, a compliance review) — is recruited in Phase 0 and drives scope for every phase after; building this platform against imagined requirements is the standard way projects in this space die.

Two operating rules govern all phases. First, weekly demos to the design partner, and everything behind the demo is real — no smoke, no hardcoded paths. Second, a phase is complete when its **exit drills** pass, not when its features merge. The drills are listed per phase and they are the plan's real content.

## 1. Timeline overview

| Phase | Weeks | Headline | Exit drill (the one-liner) |
|---|---|---|---|
| 0 — Foundations | 1–2 | Repo-to-prod pipeline + partner locked | Hello-world ships to prod via CI |
| 1 — The Spine | 3–10 | Durable runs, model gateway, traces | Kill the worker mid-run; the run finishes anyway |
| 2 — Governance | 11–20 | Tools, policy, identity, approvals | First approved **write** in prod; injection attempt blocked with audit proof |
| 3 — Quality Loop | 21–28 | Evals as CI, canary, cost | CI blocks a bad prompt; canary auto-rolls back |
| 4 — Enterprise Wrap | 29–40 | SSO/SCIM, audit export, BYOK, VPC | New tenant onboards via SSO untouched; SIEM ingesting audit live |

Cumulative: roughly 7–9 months to an enterprise-sellable platform with a small, strong team. Phases 1 and 2 are the soul of the product; 3 makes it improvable; 4 makes it buyable.

## Phase 0 — Foundations (Weeks 1–2)

**Objective:** make shipping boring before building anything interesting, and lock the design partner.

The engineering work is deliberately unglamorous: a TypeScript monorepo; CI/CD deploying to real staging and prod environments from day one; PostgreSQL provisioned; a Temporal cluster stood up under the **deploy-anywhere guardrail**: because the platform ships to client sites, no runtime dependency may be SaaS-only — Temporal Cloud is acceptable for our own dev and staging convenience, but the release artifact bundles self-hosted Temporal (and Postgres) from day one, and CI builds that installable artifact from the very first week; an OTel collector wired to a hosted trace backend (Langfuse-class to start, ClickHouse when volume justifies); secrets management (KMS-backed, nothing in env files); error tracking. Total infrastructure ambition: one `git push` results in a deployed, observable hello-world service in both environments.

The strategic work matters more: choose the design partner and the single workflow. Selection criteria — the workflow has real money or real hours attached; its systems are reachable by API; its owner tolerates supervised automation; success is measurable in one number (tickets resolved, refunds processed, hours saved). Map it end to end: systems touched, permissions needed, current human process, and its unit economics.

**Exit drills:** (1) pipeline proves itself — a change merges and reaches prod with zero manual steps; (2) the workflow map exists as a one-pager the partner has confirmed, including the success metric you will both watch for nine months.

## Phase 1 — The Spine (Weeks 3–10)

**Objective:** a real agent, on real read-only tools, running as durable, observable, budgeted workflows. No writes, no approvals, no multi-tenancy — just the spine, made unbreakable.

Four workstreams run in parallel. **(a) Run engine on Temporal:** the run/event model and reducer (RunStarted → ModelCalled → ToolIntent → ToolExecuted → RunCompleted), idempotent activities keyed by request id, per-run budgets (steps, tokens, cost, wall-clock), and loop detection that kills a run repeating the same tool call with near-identical arguments. Timebox a one-week Temporal spike at the start — the learning curve is real and front-loading it is cheaper than discovering determinism rules mid-build. **(b) Model gateway:** provider abstraction over two providers minimum, per-environment model allowlists, failover, structured-output enforcement, metering per run/step, and redaction on logged payloads. **(c) Traces:** OTel GenAI semantic conventions emitted from engine and gateway, plus a deliberately boring console page — a table of runs and a step timeline with tokens and cost per step. Resist making this beautiful; make it truthful. **(d) The first agent:** the design partner's workflow in read-only, advisory mode — it reads via 2–3 MCP tools and *recommends*, humans still act. Critically, the tools' credentials are read-only at the source system, not merely by convention. **(e) The user floor + thin schedules:** basic sign-in (OIDC) and the RBAC roles exist from this phase — the audit log's *who* depends on them — plus simple recurring schedules for read-only agents (Temporal Schedules, skip-if-running overlap, timezone-pinned), because every design partner's first request is "check X every morning." Local accounts are fine here; SSO federation and SCIM stay in Phase 4.

Deliberately deferred: anything that writes, the policy engine, approvals, sandboxes, evals, tenancy UI, run templates and event triggers (those are Phase 2).

**Exit drills:**
1. **The kill test:** `kill -9` the worker mid-run; the run resumes from its event log and completes with zero duplicated model calls or tool calls (verified in the trace).
2. **The budget test:** an adversarial prompt that induces looping is terminated by step/cost budget and flagged by loop detection.
3. **The failover test:** revoke the primary provider's key mid-traffic; runs degrade to the fallback with no failures surfaced to users.
4. **The audit test:** for any run id, the console reconstructs every step with tokens and cost, and totals match the provider invoice within 2%.
5. **The usefulness test:** the design partner's team consults the agent's read-only output weekly without being chased — if this fails, Phase 2 scope is wrong and now is the cheap moment to learn it.
6. **The schedule test:** a read-only agent scheduled for 07:00 facility-local fires on time, skips the occurrence if yesterday's run is still going, and after a simulated day of downtime does exactly what its catch-up policy says — chosen behavior, not accidental.
7. **The artifact test:** the entire Phase 1 system installs on a clean machine from the versioned release artifact (compose profile: Postgres, Temporal, worker, console) with no network access beyond the model endpoint — proving deploy-anywhere before there is anything sensitive to deploy.

## Phase 2 — Governance (Weeks 11–20)

**Objective:** the first *write* action executed in production, through policy and human approval, by an agent that could not have done it any other way. This is the phase that turns a demo into an enterprise product; it is also the longest and least skippable.

Workstreams: **(a) Tool registry** — versioned MCP contracts with JSON-Schema validation both directions and a risk tier (`read` / `write` / `irreversible` / `financial`) on every tool version. **(b) Tool gateway** — grant checks (agent × tool-version × tier), egress allowlist, server-side secret injection, and every invocation written to the audit stream with argument and result digests. **(c) Identity and delegation** — workload identity per agent per environment; OAuth token exchange so runs acting for a user hold time-boxed, scope-minimized credentials; autonomous agents run under narrow service identities reviewed like privileged accounts. **(d) Policy engine** — Cedar/OPA-class, decisions of allow / deny / require-approval recorded with the rule that fired. Start with the fewer-than-ten rules the partner workflow actually needs; policy frameworks die of premature generality. **(e) Approval inbox** — full intent preview with diff-style rendering of mutations, approve/deny with comment, delegation, escalation on SLA breach, expiry defaulting to deny, and sane batching of low-risk changesets. Spend design effort here: this screen is what enterprise buyers judge. **(f) Sandbox pool** for code-execution and browsing tools (microVM-class isolation, no default network) — build only if the partner workflow needs it; otherwise it slides to Phase 3 without guilt. **(g) Trigger subsystem + standing delegations** — run templates (agent version + bound parameters) as saved, shareable objects with view/edit/trigger grants; event triggers (registered webhooks) governed like any control-plane object; full schedule management (overlap, catch-up, pause/resume); and standing delegation grants so unattended runs can act for a user — named tools only, mandatory expiry, one-click revocation, every use audited. This lands here rather than later because it is identity work: it reuses (c)'s token machinery.

**Exit drills:**
1. **The write:** one irreversible-tier action (the partner's real one — a refund, a ticket close, an email) executes in prod after a human approves it in the inbox; the audit chain shows intent → policy decision → approver → execution.
2. **The environment split:** the identical intent auto-executes in dev and demands approval in prod, by policy alone.
3. **The red team:** a document retrieved by the agent contains embedded instructions to call an out-of-grant tool and exfiltrate data; the gateway refuses on grant and egress grounds, and the audit stream shows the attempt. Run this drill with someone who wants it to fail.
4. **The grant test:** an agent invoking any tool outside its grant is refused at the gateway regardless of what the model asks for.
5. **The secrets scan:** automated scan of every logged prompt and completion confirms no credential material ever entered a context window.
6. **The auditor's question:** for any action in prod, one query answers who/what/when/on-whose-behalf/under-which-rule in under a minute.
7. **The 2 a.m. test:** a scheduled run executes a governed action overnight under a standing delegation; the audit shows the grant, its scope, and its exercise — and revoking the grant halts the next occurrence at the policy check instead of falling back to any broader credential.

## Phase 3 — The Quality Loop (Weeks 21–28)

**Objective:** make change safe. After this phase, improving an agent is routine engineering — versioned, gated, canaried, reversible — rather than vibes and prayer.

Workstreams: **(a) Eval harness** — golden scenario suites per agent with hard assertions (correct tool chosen, correct arguments, zero policy violations, outcome achieved) plus LLM-as-judge rubrics for response quality, with judge model versions pinned. Harvest scenarios from real Phase 1–2 traces rather than inventing them; synthetic suites certify nothing. **(b) CI gating** — any change to prompt, agent config, or model version runs the suite; red blocks promotion exactly like a failing test. **(c) Versioning and promotion UX** — immutable agent versions, environment pointers, one-click rollback. **(d) Canary** — new versions take a traffic slice with automatic rollback on online-score or cost regression. **(e) Online sampling** — a percentage of prod runs scored asynchronously, drift alarms on tool-error rates and judge scores. **(f) Cost dashboards** — per run, per agent, per tenant, and above all *per outcome*, because "$1.40 per resolved ticket" is the sentence that renews contracts. **(g) Connector scale kit** — the OpenAPI→tool generator and the connector SDK (architecture §6), turning "can you connect to X" from an engineering project into configuration; first-party connectors continue to be built only against paying demand.

**Exit drills:**
1. **The bad-prompt test:** a deliberately degraded prompt change is blocked by CI with a legible diff of which scenarios failed and why.
2. **The rollback drill:** a canaried version with a seeded regression is rolled back automatically, and the timeline shows detection-to-rollback under ten minutes with no human in the loop.
3. **The model-swap drill:** a new model version is evaluated across every agent's suite in one command; green agents promote, red agents hold — the exact motion a provider deprecation will force on you for real.
4. **The economics test:** the design partner can state the workflow's cost-per-outcome from the dashboard, unprompted.

## Phase 4 — Enterprise Wrap (Weeks 29–40)

**Objective:** become buyable. Nothing in this phase is intellectually novel and all of it decides whether procurement signs. Scope it against the security questionnaires of real prospects, not imagined ones — this phase expands to fill all available time if you let it.

Workstreams: **(a)** SSO (SAML/OIDC) and SCIM provisioning — federating the local accounts and roles that have existed since Phase 1. **(b)** Tenancy hardening — schema-per-tenant baseline, a deployment-per-tenant profile for regulated buyers. **(c)** WORM audit export streaming to customer SIEMs in Splunk/Datadog-native formats. **(d)** Encryption with per-tenant keys and BYOK, including a key-revocation drill. **(e)** VPC/self-hosted packaging of the **entire platform, both planes** (Helm charts, air-gap-tolerant, telemetry phone-home optional and honest) — hardening the artifact that has shipped since the Phase 1 artifact test, not introducing it. **(f)** Retention policies and legal hold on run logs. **(g)** SOC 2 Type I underway — the audit stream built since Phase 2 does most of the evidence work; that was the point of building it early. **(h)** Tenant-level admin: budgets, rate limits, kill switches per agent/tenant/global. **(i)** The sales artifacts: security whitepaper, pen-test report, pricing that maps to metered cost data from Phase 3.

**Exit drills:**
1. **The onboarding test:** a second tenant goes from contract to first governed agent run using SSO/SCIM with zero vendor-side manual steps.
2. **The SIEM test:** the customer's security team confirms live audit ingestion and can answer the auditor's question from *their* tooling.
3. **The VPC test:** a clean self-hosted install of the entire platform completes from published artifacts in under a day.
4. **The revocation drill:** customer revokes their BYOK key; their tenant data is verifiably unreadable; nothing else degrades.
5. **The reference:** two lighthouse workflows in production willing to take a prospect's call.

## Running threads (all phases)

Three practices run continuously rather than belonging to any phase. The **partner cadence**: weekly demo, monthly metric review against the Phase 0 success number. The **security gate**: each phase ends with an internal adversarial review — someone whose job is to break what was just built, with the red-team drill of Phase 2 repeated against every new surface. **Docs as exhaust**: runbooks written while operating, because in Phase 4 they become the ops manual customers demand.

## If pressure forces cuts

Safe to cut or defer: the sandbox pool (if the partner workflow needs no code execution), automated canary (manual promotion with fast rollback is acceptable at low volume), SCIM (manual invites scale surprisingly far), deployment-per-tenant (until a regulated buyer pays for it). Never cut, in order of catastrophe: run durability, the tool gateway, the audit stream, the approval flow. Those four are the product; everything else is packaging around them.
