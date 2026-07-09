# Enterprise Agentic Platform — Production Reference Architecture (v1)

Scope: a platform on which an enterprise's teams define, deploy, govern, and observe AI agents — long-running AI workers that reason with LLMs and act on real business systems through tools. The buyers are platform engineering and security; the users are application teams shipping agents; the stakeholders are auditors, compliance, and the CISO. This document defines the architecture that makes all four groups say yes.

## 1. The core thesis

An LLM is a brilliant, fast, occasionally wrong employee with no memory of company policy. Enterprises do not deploy such an employee by giving them root access — they wrap them in process: scoped permissions, approval chains, audit trails, budgets, and performance reviews. This platform is that process, made of software.

Every design decision below follows from one principle: **wrap non-determinism in deterministic infrastructure.** The model proposes; the platform disposes. Concretely, seven commitments define production-grade:

1. **Every agent run is durable and event-sourced.** No agent loop lives in process memory. A run is a persisted sequence of events that can crash, resume, pause for three days awaiting human approval, and be replayed step-by-step in an audit two years later.
2. **Agents are first-class security principals.** An agent has its own workload identity and acts on behalf of users through delegated, scoped, time-boxed credentials — never borrowed passwords, never a god-mode service account.
3. **All side effects pass through a governed tool gateway.** The model never touches a database, API, or browser directly. It emits *intents*; the gateway validates, authorizes, policy-checks, executes, and records them.
4. **Everything entering the context window from outside is data, not instructions.** Retrieved documents, tool results, emails, and web pages are untrusted by default — prompt injection is treated as a permanent condition to be contained, not a bug to be fixed.
5. **Evals are CI.** No prompt, agent config, or model version reaches production without passing an evaluation gate, and every production run is traced, costed, and sampled for quality drift.
6. **Buy the commodity, build the differentiation.** Durable workflow engines, model routing, and trace collection are solved problems. The platform's value is the governance layer: tool contracts, policy, approvals, and the eval loop — that is where engineering effort goes.
7. **The platform ships to the client.** Client-site deployment is a first-class distribution model, not an escape hatch: the entire system installs inside a customer's network from a versioned artifact, which means every runtime dependency must be open-source, self-hostable, or client-provided. A SaaS-only dependency anywhere in the runtime path is an architecture violation.

## 2. System topology

The platform splits into a **control plane** (where humans configure and govern) and a **data plane** (where agents execute). They scale, fail, and are secured independently.

```
 CONTROL PLANE                              DATA PLANE
┌───────────────────────────┐   ┌─────────────────────────────────────────┐
│ Console (web)             │   │  Run Engine (durable execution)         │
│  · agent registry/versions│   │  ┌────────────────────────────────────┐ │
│  · tool registry          │   │  │ run = event log:                   │ │
│  · policies & approvals   │──▶│  │  plan → model call → tool intent   │ │
│  · RBAC / SCIM / tenants  │   │  │  → policy check → (approval?)      │ │
│  · budgets & kill switches│   │  │  → execute → observe → repeat      │ │
│  · schedules & triggers   │   │  │                                    │ │
│  · eval suites & gates    │   │  └───────┬──────────────┬─────────────┘ │
└───────────┬───────────────┘   │          ▼              ▼               │
            │ config,           │   Model Gateway    Tool Gateway         │
            │ promotion         │   · provider       · authZ + OBO creds  │
            ▼                   │     routing        · schema validation  │
┌───────────────────────────┐   │   · failover       · egress allowlist   │
│ Postgres (system of       │   │   · caching        · secret injection   │
│ record: registry, runs,   │   │   · cost meter     · risk-tier policy   │
│ policies, audit)          │   │   · redaction      · full audit         │
└───────────────────────────┘   │        │                │               │
                                │        ▼                ▼               │
┌───────────────────────────┐   │   LLM providers    Enterprise systems   │
│ Observability pipeline    │◀──│   (Anthropic, ...)  (via MCP servers)   │
│ · OTel traces → ClickHouse│   │                    Sandbox pool         │
│ · cost & token metering   │   │                    (microVMs: code,     │
│ · online eval sampling    │   │                     browser, files)     │
└───────────────────────────┘   └─────────────────────────────────────────┘
```

Memory and knowledge services (run context, long-term memory, RAG) sit alongside the data plane and are covered in §7.

## 3. Control plane — agents, triggers, and ownership

The control plane is the system of record for *what is allowed to exist and run*. An **agent** here is not code — it is a versioned configuration object: model + prompt bundle + tool grants + policies + budgets + memory settings + eval suite. Versions are immutable; environments (dev → staging → prod) hold references to versions; promotion is a recorded, gated act, exactly like an artifact promotion in CD. Rollback is a pointer flip, not a redeploy.

Tenancy is hierarchical — organization → workspace → environment — with RBAC roles (platform admin, agent developer, approver, auditor, viewer) provisioned via SCIM and authenticated via SSO/SAML/OIDC. Every mutation in the control plane lands in the same immutable audit stream as data-plane actions, because "who changed the policy" matters as much as "what the agent did."

Because agents are configuration, *invocations* are configuration too. A **run template** binds an agent version to concrete parameters ("refund-review, region = EMEA, limit = $500") as a saved, shareable object — the thing a user re-runs in one click instead of re-assembling. **Triggers** attach templates to time or to events: schedules (cron-grade, timezone-pinned, built on Temporal Schedules) and event triggers (registered webhooks or queue subscriptions that start a run when the world changes). Schedules carry the operational policies that separate toys from platforms — overlap policy (skip, queue, or cancel-previous when the prior occurrence is still running), catch-up policy after downtime (run missed occurrences or drop them, chosen explicitly), jitter, and pause/resume — and every template, schedule, and trigger is versioned, environment-scoped, and audited exactly like an agent.

Ownership and sharing sit one level finer than roles: every object — agent, template, schedule, trigger — has an owner and explicit share grants (view / edit / trigger), so "developer in the workspace" never silently means "may fire the refund agent." Notification routing is likewise per-user: approval requests and run outcomes reach people where they actually live — Slack, email, mobile push — under each user's routing rules, because an approval inbox nobody sees is a policy engine that silently times out to deny.

## 4. The run engine — durable execution

This is the single most consequential technical decision. Agent runs are long-lived (minutes to weeks), interruptible (approvals, rate limits, provider outages), and legally interesting (audits). Therefore a run is a **durable workflow**: an append-only event log plus a deterministic reducer, executed by a durable-execution engine — Temporal is the pragmatic choice; an event-sourced engine on Postgres is the lean alternative. In-memory `while` loops around an LLM call are disqualified at the design level.

A run's event log reads like this:

```
RunStarted        { agent: support-triage@v14, principal: user:jane, input }
ModelCalled       { gateway_req: 7f2c, tokens_in: 3211, tokens_out: 402, cost }
ToolIntent        { tool: zendesk.update_ticket@v3, args, risk: write }
PolicyEvaluated   { decision: require_approval, rule: write-in-prod }
ApprovalRequested { approver_group: support-leads, expires: +4h }
ApprovalGranted   { by: user:omar, at, comment }
ToolExecuted      { gateway_req: 9a11, result_digest, latency_ms }
ModelCalled       { ... }
RunCompleted      { outcome, total_cost, steps: 6 }
```

Consequences of this shape: activities (model calls, tool calls) are idempotent with request keys, so retries never double-execute a side effect; a crash resumes from the log; "pause for human" is just an event the workflow awaits; and replay gives auditors and debuggers a perfect flight recorder. Every run carries **budgets** — max steps, max tokens, max cost, max wall-clock — enforced by the engine, with loop detection (same tool + similar args N times) terminating runaways. Compensation logic (undo/rollback intents) is declared per tool where possible, because some failures must be unwound, not retried.

## 5. Model gateway

All LLM traffic — every agent, every environment — flows through one internal gateway. It provides provider abstraction and failover (Anthropic/OpenAI/self-hosted behind one interface), model allowlists per environment (prod pins approved versions; dev may roam), response caching, structured-output enforcement, and PII redaction on logged payloads. Most importantly it is the **metering point**: tokens and cost are attributed per tenant, per agent, per run, per step, feeding budgets, chargeback, and the CFO dashboard. When a provider degrades, the gateway is where circuit breakers and failover policies act — agents upstream just see slower steps, not outages.

## 6. The tool layer — where safety actually lives

Tools are the platform's crown jewels, because tools are where an agent stops being a chatbot and starts touching production. The design has four parts.

**Contracts.** Every tool is a versioned, typed contract — MCP (Model Context Protocol) is the interface standard, giving a uniform way to wrap internal APIs, SaaS systems, and databases. Input and output are JSON-Schema validated *at the gateway*, both directions: malformed intents never reach systems, and malformed results never reach the context window unlabeled.

**Risk tiers.** Every tool version is classified: `read` (query CRM), `write` (update ticket), `irreversible` (send email, delete record), `financial` (issue refund). Tiers are not documentation — they are the input to policy. Default posture: reads auto-execute, writes auto-execute with logging in dev but require approval in prod until an agent earns trust, irreversible and financial always require approval or explicit standing policy signed off by a human owner.

**The gateway.** At execution time the tool gateway (a) checks the agent's grant for that tool version, (b) evaluates policy with full context — agent, principal, tier, arguments, environment, (c) exchanges the run's delegated credential for a downstream token, (d) injects secrets server-side so credentials never appear in any context window, (e) enforces an egress allowlist (an agent for HR cannot call the payments API, period), and (f) writes the invocation, arguments, and result digest to the audit stream.

**Sandboxes.** Code execution, browsing, and file manipulation run in disposable microVMs (Firecracker/gVisor class isolation): no network by default, explicit mount of only the run's artifacts, hard CPU/memory/time limits, destroyed after use. Anything an agent renders or executes from untrusted content happens in there.

**Connecting client systems.** Any system a client already uses becomes connectable by wrapping it as an MCP server — and the moment it is wrapped, it inherits the entire governance stack (grants, risk tiers, policy, approvals, audit, egress) with zero additional integration logic. Client systems arrive in four effort tiers: modern SaaS (existing ecosystem MCP servers; days of work), internal APIs and databases (straightforward custom servers; prefer APIs over direct DB access, which bypasses the client's own business logic — where unavoidable, read-only scoped views under a harsh risk tier), legacy on-prem (SOAP-era systems; fully connectable but priced as real per-system integration work), and no-API systems (sandboxed browser automation with heavy approvals, or an explicit human step — brittle by nature, promised carefully). The platform avoids drowning in bespoke connectors through four levers: adopt ecosystem MCP servers where they exist, build first-party ones only against paying demand, ship a **connector SDK** so clients and integrators wrap their own internal systems, and provide two generic escape hatches — an **OpenAPI→tool generator** (point at any OpenAPI spec, receive governed tools) and a scoped read-only SQL tool — which together cover a large fraction of "connect everything." Commitment #7 quietly strengthens all of this: deployed inside the client's network, the platform reaches internal systems a cloud SaaS never could, and their data never leaves the building.

## 7. Identity, delegation, and memory

Each agent holds a **workload identity** (SPIFFE-style), distinct per environment. When a run acts for a user, the platform performs a token exchange: the user's session yields a delegated credential scoped to exactly the tools that run may use, time-boxed to the run. Autonomous (unattended) agents run under narrow service identities whose grants are reviewed like any privileged account. The invariant, stated bluntly: *no agent ever holds a credential broader than the single action it is about to take*, and no raw secret ever enters a prompt.

Scheduled and event-triggered runs break the live-session assumption: at 2 a.m. there is no logged-in user to exchange a token from. The platform therefore supports **standing delegation grants** — a first-class, auditable object in which a user pre-authorizes a specific template or schedule to act as them, restricted to named tools and risk tiers, with a mandatory expiry, one-click revocation, and every exercise of the grant logged against both the user and the schedule. Where no personal authority is needed, the run executes under the agent's narrow service identity instead. Either way, the invariant above survives the absence of a session; what is never acceptable is a scheduler quietly running on a stored admin credential.

Memory splits into three stores with different rules. **Run context** is the event log itself — complete, immutable, retained per policy. **Long-term agent memory** (facts learned across runs) is per-tenant and per-subject, every entry carrying provenance (which run, which source) and TTL, with a deletion API because right-to-be-forgotten requests will arrive. **Enterprise knowledge (RAG)** indexes governed corpora, and retrieval enforces the *calling user's* ACLs at query time — the classic enterprise failure is an agent that helpfully surfaces a document its user was never allowed to read. Retrieved content enters context wrapped in provenance labels and is treated per commitment #4: data, never instructions.

## 8. Policy and human-in-the-loop

Policy is code, not tribal knowledge: a Cedar/OPA-class engine evaluates every tool intent against declarative rules over (agent, version, principal, tool, tier, arguments, environment, time). Decisions are allow, deny, or **require approval** — and the decision itself is recorded alongside the rule that fired, which is what turns an audit from archaeology into a query.

Approvals are a product surface, not an afterthought: an inbox showing the full intent (what the agent wants to do, to what, on whose behalf, with which arguments), diff-style previews for mutations, approve/deny with comment, delegation, escalation on SLA breach, and expiry with safe default (deny). Approvals batch sanely — ten low-risk writes in one run can present as one reviewable changeset. The long-term trajectory is earned autonomy: an action class moves from always-approve to spot-check to auto-execute as its eval and incident record justifies, and that promotion is itself a policy change with an owner and an audit entry.

## 9. Observability, evals, and release engineering

Every run emits OpenTelemetry traces using the GenAI semantic conventions — one trace per run, spans per step, attributes for tokens, cost, model, tool, policy decision — flowing to a columnar store (ClickHouse-class) for the dashboards that matter: cost per run and per outcome, success and interruption rates, approval latency, tool error rates, drift alarms.

Quality is enforced in two loops. **Offline, pre-deploy:** every agent owns an eval suite — golden scenario sets with assertions (correct tool chosen, correct arguments, no policy violations, outcome achieved) plus LLM-as-judge rubrics for quality — run in CI against every prompt/config/model change; failing gates block promotion, exactly like failing tests. **Online, post-deploy:** sampled production runs are scored asynchronously, new versions canary against a traffic slice with automatic rollback triggers, and incidents route to a replay view where an engineer steps through the event log to the exact decision that went wrong. Model deprecations become routine: re-run every agent's suite against the successor model, promote where green, hold where red.

## 10. Enterprise baseline

The non-negotiables that make procurement say yes, designed in from day one rather than retrofitted: single-tenant-grade isolation options (schema-per-tenant minimum, database- or deployment-per-tenant for regulated buyers); SSO/SAML/OIDC with SCIM provisioning; a WORM audit stream exportable to the customer's SIEM; encryption at rest with per-tenant keys and BYOK; data residency pinning for both storage and model endpoints; configurable retention and legal hold on run logs; a self-hosted/VPC deployment shape (the data plane containerizes cleanly precisely because of the control/data split); and SOC 2 Type II controls mapped to the audit stream from the start. None of this is glamorous; all of it is why enterprises sign.

**Deployment model.** One codebase ships in two profiles: a hosted multi-tenant cloud that we operate, and a **single-tenant client-site installation** in which both planes — control and data — run entirely inside the customer's network, delivered as a versioned Helm chart for their Kubernetes with a docker-compose profile for pilots and small footprints. The shippable-dependency rule (commitment #7) is what makes this a packaging exercise instead of a rewrite: Temporal and Postgres are bundled self-hosted or pointed at client-managed instances, traces flow over OTel into the client's observability stack (a bundled ClickHouse/Langfuse is optional, not required), SSO federates directly against the client's IdP over SAML/OIDC with no SaaS identity broker inside the artifact, and secrets come from the client's Vault or KMS. The platform's only required egress is to model endpoints — and even that is pluggable: Anthropic's API, private Bedrock/Vertex/Azure endpoints, the client's internal LLM gateway, or a documented air-gap profile serving local models with explicitly reduced capability. Releases are semver'd artifacts — images, chart, forward-only migrations — installable offline from a registry tarball; telemetry phone-home is opt-in and honest; license enforcement verifies offline.

## 11. Reference stack

| Layer | Choice | Build or buy |
|---|---|---|
| Durable run engine | Temporal (or event-sourced Postgres engine) | Buy/adopt |
| System of record | PostgreSQL | Adopt |
| Model gateway | Thin internal service (LiteLLM-class as base) | Adopt + extend |
| Tool contracts | MCP servers per system | Adopt standard, build servers |
| Tool gateway & policy | Cedar/OPA engine + custom gateway | **Build — core IP** |
| Approvals & console | Next.js/TypeScript control-plane app | **Build — core IP** |
| Sandboxes | Firecracker / gVisor pool on K8s | Adopt + integrate |
| Traces & analytics | OTel → ClickHouse (Langfuse-class to start) | Adopt |
| Evals | Harness integrated into CI + console | **Build — core IP** |
| Identity | OIDC + SPIFFE-style workload identity, token exchange | Adopt patterns |

The build column is deliberately short: tool governance, approvals UX, and the eval loop are the product; everything else is plumbing the industry has already standardized.

## 12. Non-goals for v1

No visual drag-and-drop workflow builder, no agent marketplace, no fine-tuning infrastructure, no exotic multi-agent swarms (a run may invoke sub-agents as tools — same gateway, same policy, same budgets — which covers 95% of real orchestration), and no custom vector database. Each cut is reversible later; each would sink v1.

## 13. Build order

Phase 1 proves the spine: run engine + model gateway + traces, one real agent on read-only tools, end to end. Phase 2 makes it enterprise-shaped: tool registry, gateway, risk tiers, policy engine, approval inbox — culminating in the first *write* action executed in production through an approval. Phase 3 makes it improvable: eval harness in CI, version promotion, canary and rollback. Phase 4 makes it sellable: SSO/SCIM, audit export, tenancy hardening, BYOK, VPC deploy. The discipline throughout: one design-partner workflow of real economic value (a refund pipeline, a triage queue, a compliance review) driven end-to-end beats ten demos — breadth is what kills platforms in this space, depth is what sells them.
